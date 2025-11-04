import OpenAI from 'openai';

const apiKey = process.env.OPENAI_API_KEY;
export const aiEnabled = Boolean(apiKey);
const client = apiKey ? new OpenAI({ apiKey }) : null;

export async function rerankFilesWithAI(queryText, candidates, topK = 5) {
  if (!client || !candidates?.length) return candidates;

  const items = candidates.map((c, i) => ({
    id: String(i),
    name: c.file_name || c.name || '',
    tags: Array.isArray(c.tags) ? c.tags.join(', ') : (c.tags || ''),
    description: c.description || '',
    url: c.file_url || ''
  }));

  const system = `You are a retrieval and ranking assistant for design files.
Given a user query and a JSON array of file metadata, return the best matches in order.
Output strictly as JSON: {"ranked": [{"index": <number>, "score": <0..1>} ...] } where index refers to the original position in the input array.`;

  const user = JSON.stringify({ query: queryText, items });

  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.0
  });

  const text = res.choices?.[0]?.message?.content?.trim() || '';
  let ranked = [];
  try {
    const parsed = JSON.parse(text);
    ranked = Array.isArray(parsed.ranked) ? parsed.ranked : [];
  } catch (_) {
    // If parsing fails, just return original order
    return candidates;
  }

  const order = ranked
    .filter(r => r && typeof r.index === 'number')
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .map(r => r.index);

  const unique = Array.from(new Set(order)).filter(i => i >= 0 && i < candidates.length);
  const reordered = unique.map(i => candidates[i]);
  // append any missing items to preserve completeness
  for (let i = 0; i < candidates.length; i++) {
    if (!unique.includes(i)) reordered.push(candidates[i]);
  }

  return reordered.slice(0, topK);
}
