import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// very small English stopword list to improve matching for natural phrases
const STOPWORDS = new Set([
  'a','an','the','and','or','but','if','then','else','when','what','which','who','whom','this','that','those','these','is','are','was','were','be','been','being','am','do','does','did','doing','have','has','had','having','can','could','should','would','may','might','must','will','shall','i','you','he','she','it','we','they','me','him','her','us','them','my','your','our','their','to','from','in','on','at','for','of','by','with','as','about','into','over','after','before','up','down','out','off','again','further','then','once','here','there','why','how','hey','please','share','send','latest','new','newest'
]);

function normalizeAndTokenize(queryText) {
  const raw = String(queryText || '').toLowerCase();
  const all = raw.split(/[^a-z0-9]+/).filter(Boolean);
  const tokens = all
    .map(t => (t.endsWith('s') ? t.slice(0, -1) : t)) // simple plural -> singular
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
  return tokens.length ? tokens : all; // fallback to all tokens if everything filtered
}

export async function getOrCreateWorkspace(teamId, teamName) {
  const { data: existing, error: fetchError } = await supabase
    .from('workspaces')
    .select('*')
    .eq('team_id', teamId)
    .single();
  if (existing && !fetchError) return existing;

  const { data, error } = await supabase
    .from('workspaces')
    .insert({ team_id: teamId, team_name: teamName, installed_at: new Date().toISOString() })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function searchFiles(queryText, workspaceId, limit = 10) {
  const tokens = normalizeAndTokenize(queryText);
  const primary = tokens.slice().sort((a, b) => b.length - a.length)[0] || '';

  // 1) Prefer a DB-side filter on safe text columns using the strongest token
  let rows = [];
  if (primary) {
    const q = `%${primary}%`;
    const filtered = await supabase
      .from('files')
      .select('*')
      .eq('workspace_id', workspaceId)
      .or(`file_name.ilike.${q},name.ilike.${q},description.ilike.${q},project.ilike.${q},tags_text.ilike.${q}`)
      .order('uploaded_at', { ascending: false })
      .limit(200);
    if (filtered.error) throw filtered.error;
    rows = filtered.data ?? [];
  }

  // 2) If nothing found (or no primary token), fetch recent workspace rows as fallback candidates
  if (!rows.length) {
    const scoped = await supabase
      .from('files')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('uploaded_at', { ascending: false })
      .limit(200);
    if (scoped.error) throw scoped.error;
    rows = scoped.data ?? [];
  }

  // 3) Potential cross-workspace legacy fallback: only if we get no positive scores later
  let legacyRows = [];

  // Score candidates locally across name, description, project, and tags (array or text)
  const scoreList = (arr) => arr.map(r => {
    const name = String(r.file_name || r.name || '').toLowerCase();
    const project = String(r.project || '').toLowerCase();
    const tagsStr = Array.isArray(r.tags)
      ? r.tags.map(x => String(x)).join(' ').toLowerCase()
      : String(r.tags || r.tags_text || '').toLowerCase();
    const desc = String(r.description || '').toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (!t) continue;
      if (name.includes(t)) score += 8;
      if (name.startsWith(t)) score += 4;
      if (project.includes(t)) score += 3;
      if (tagsStr.includes(t)) score += 3;
      if (desc.includes(t)) score += 2;
    }
    return { row: r, score };
  });

  const scoredPrimary = scoreList(rows).filter(x => x.score > 0);
  let scoredLegacy = [];
  if (!scoredPrimary.length) {
    // fetch legacy set lazily only when needed
    const legacy = await supabase
      .from('files')
      .select('*')
      .order('uploaded_at', { ascending: false })
      .limit(200);
    if (legacy.error) throw legacy.error;
    legacyRows = legacy.data ?? [];
    scoredLegacy = scoreList(legacyRows).filter(x => x.score > 0);
  }

  // If no positive matches at all, return empty to let caller message "no results"
  const positives = scoredPrimary.length ? scoredPrimary : scoredLegacy;
  if (!positives.length) {
    return [];
  }

  const result = positives
    .sort((a, b) => b.score - a.score)
    .map(x => x.row);
  return result.slice(0, limit);
}

// Upload a file buffer to Supabase storage and return a public URL
export async function uploadFileToStorage(fileBuffer, fileName) {
  const safeName = String(fileName || 'upload').replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = `${Date.now()}_${safeName}`;

  const { error: uploadError } = await supabase.storage
    .from('design_files')
    .upload(filePath, fileBuffer, {
      contentType: 'application/octet-stream',
      upsert: false
    });
  if (uploadError) throw uploadError;

  const { data: urlData } = supabase.storage
    .from('design_files')
    .getPublicUrl(filePath);

  return { path: filePath, url: urlData.publicUrl };
}

// Save uploaded file metadata to the existing files table schema used by retrieval
export async function saveUploadedFileMetadata({
  workspace_id,
  user_id,
  file_name,
  tags,
  description,
  file_url,
  slack_file_id
}) {
  const tagsText = Array.isArray(tags)
    ? tags.map(x => String(x)).join(' ')
    : String(tags || '') || null;
  const payload = {
    workspace_id,
    user_id,
    file_name,
    // Backward-compat for older schema
    name: file_name,
    project: null,
    tags: tags || null,
    tags_text: tagsText,
    description: description || null,
    file_url,
    slack_file_id: slack_file_id || null,
    uploaded_at: new Date().toISOString(),
    last_accessed_at: new Date().toISOString()
  };
  const { error } = await supabase.from('files').insert(payload);
  if (error) throw error;
}

// ----------------------------
// OAuth Installation Store API
// ----------------------------

// Persist a Slack installation (bot/user tokens, team info)
export async function storeSlackInstallation(installation) {
  const team_id = installation.team?.id || null;
  const enterprise_id = installation.enterprise?.id || null;
  const is_enterprise = Boolean(installation.isEnterpriseInstall);
  const user_id = installation.user?.id || null;

  // Upsert by team_id/enterprise_id to avoid duplicates
  const { error } = await supabase
    .from('installations')
    .upsert(
      [{ team_id, enterprise_id, is_enterprise, user_id, data: installation }],
      { onConflict: 'team_id' }
    );
  if (error) throw error;
}

// Fetch an installation for a workspace or enterprise
export async function fetchSlackInstallation({ teamId, enterpriseId, isEnterpriseInstall }) {
  const query = supabase
    .from('installations')
    .select('data')
    .limit(1);

  if (isEnterpriseInstall && enterpriseId) {
    const { data, error } = await query.eq('enterprise_id', enterpriseId).maybeSingle();
    if (error) throw error;
    return data?.data || null;
  } else if (teamId) {
    const { data, error } = await query.eq('team_id', teamId).maybeSingle();
    if (error) throw error;
    return data?.data || null;
  }
  return null;
}

// Delete an installation (on app uninstall)
export async function deleteSlackInstallation({ teamId, enterpriseId, isEnterpriseInstall }) {
  let del;
  if (isEnterpriseInstall && enterpriseId) {
    del = await supabase.from('installations').delete().eq('enterprise_id', enterpriseId);
  } else if (teamId) {
    del = await supabase.from('installations').delete().eq('team_id', teamId);
  }
  if (del?.error) throw del.error;
}
