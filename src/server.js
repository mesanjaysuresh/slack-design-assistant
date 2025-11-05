import 'dotenv/config';
import bolt from '@slack/bolt';
const { App, ExpressReceiver } = bolt;
import pino from 'pino';
import { supabase, getOrCreateWorkspace, searchFiles, uploadFileToStorage, saveUploadedFileMetadata, storeSlackInstallation, fetchSlackInstallation, deleteSlackInstallation } from './supabase.js';
import { aiEnabled, rerankFilesWithAI } from './ai.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Enable OAuth installer if client credentials are present
const useOAuth = Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET && process.env.SLACK_STATE_SECRET);

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events',
  ...(useOAuth
    ? {
        clientId: process.env.SLACK_CLIENT_ID,
        clientSecret: process.env.SLACK_CLIENT_SECRET,
        stateSecret: process.env.SLACK_STATE_SECRET,
        scopes: [
          'commands',
          'chat:write',
          'files:read',
          'im:read',
          'im:write',
          'im:history',
          'users:read'
        ],
        installationStore: {
          storeInstallation: async (installation) => {
            await storeSlackInstallation(installation);
          },
          fetchInstallation: async (query) => {
            return await fetchSlackInstallation(query);
          },
          deleteInstallation: async (query) => {
            await deleteSlackInstallation(query);
          }
        },
        installerOptions: {
          directInstall: true,
          installPath: '/slack/install',
          redirectUriPath: '/slack/oauth_redirect'
        }
      }
    : {})
});

const app = new App({
  ...(useOAuth ? {} : { token: process.env.SLACK_BOT_TOKEN }),
  receiver
});

// Health endpoint via ExpressReceiver
receiver.app.get('/health', (_req, res) => {
  res.status(200).send('ok');
});

// Optional landing route to avoid 404s on '/'
receiver.app.get('/', (_req, res) => {
  res.status(200).send('Slack Design Assistant is running');
});

app.event('message', async ({ event, client, say, logger: boltLogger }) => {
  try {
    if (event.channel_type !== 'im' || event.bot_id) return;
    const text = (event.text || '').trim();
    if (!text) return;
    if (text.startsWith('/')) return;

    // Workspace scoping (robust team_id resolution)
    let teamId = event.team;
    if (!teamId) {
      try {
        const auth = await client.auth.test();
        teamId = auth.team_id || teamId;
      } catch {}
    }
    if (!teamId) {
      await say("Sorry, I couldn't determine your workspace. Please try again.");
      return;
    }
    const workspace = await getOrCreateWorkspace(teamId, 'Unknown Team');
    logger.info({ evt: 'search_start', teamId, workspaceId: workspace?.id, text });

    const userInfo = await client.users.info({ user: event.user });
    const userEmail = userInfo.user?.profile?.email;

    let results = await searchFiles(text, workspace.id, 10);
    logger.info({ evt: 'search_results_raw', count: results?.length || 0 });
    // AI re-rank (optional)
    if (aiEnabled && results.length > 1) {
      results = await rerankFilesWithAI(text, results, 5);
    }

    // simple access gate (company/public)
    const accessible = results.filter(f => {
      if (!f.privacy || f.privacy === 'public' || f.privacy === 'company') return true;
      const allowed = (f.allowed_user_emails || []).map(e => String(e).toLowerCase());
      return userEmail && allowed.includes(userEmail.toLowerCase());
    });
    logger.info({ evt: 'search_results_accessible', count: accessible.length });

    if (accessible.length === 0) {
      await say("I couldn't find any matching files. Try different keywords, or upload with /upload-design.");
      return;
    }

    // Prefer best single result to avoid confusion
    if (accessible.length >= 1) {
      const f = accessible[0];
      const displayName = (f.file_name || f.name || '').trim() || 'Untitled';
      await client.chat.postMessage({
        channel: event.channel,
        text: displayName,
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*${displayName}*\n<${f.file_url}|Open file>` }
          }
        ]
      });
      return;
    }
  } catch (err) {
    boltLogger?.error(err);
    logger.error({ evt: 'search_error', err: String(err?.message || err) });
    try { await say('Something went wrong while searching. Please try again.'); } catch {}
  }
});

// Installation-like bootstrap using app_home_opened to create workspace and DM welcome
app.event('app_home_opened', async ({ event, client, logger: boltLogger }) => {
  try {
    const teamId = event?.view?.team_id || event?.team;
    if (!teamId) return;
    const teamInfo = await client.team.info();
    const teamName = teamInfo?.team?.name || 'Unknown Team';
    await getOrCreateWorkspace(teamId, teamName);
    await client.chat.postMessage({
      channel: event.user,
      text: 'Welcome to Design Assistant! 👋',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `👋 Hey there! I’m Popeye, your Design Assistant in Slack.\n\nYou can upload design files, search, or ask me to fetch files anytime, all right here in Slack.\n\nTry:\n• \`/upload-design\` → Upload a file\n• Find the latest ORCA dashboard mockup → retrieve files` }
        }
      ]
    });
  } catch (err) {
    boltLogger?.error(err);
  }
});

// Slash command: /upload-design → open modal
app.command('/upload-design', async ({ command, ack, client, logger: boltLogger }) => {
  await ack();
  try {
    await client.views.open({
      trigger_id: command.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'upload_design_modal',
        private_metadata: command.channel_id,
        title: { type: 'plain_text', text: 'Upload Design File' },
        submit: { type: 'plain_text', text: 'Upload' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input',
            block_id: 'file_name',
            element: {
              type: 'plain_text_input',
              action_id: 'file_name_input',
              placeholder: { type: 'plain_text', text: 'e.g., ORCA Dashboard Mockup v2' }
            },
            label: { type: 'plain_text', text: 'File Name' }
          },
          {
            type: 'input',
            block_id: 'file_upload',
            element: {
              type: 'file_input',
              action_id: 'file_upload_input'
            },
            label: { type: 'plain_text', text: 'File (optional if URL provided)' },
            optional: true
          },
          {
            type: 'input',
            block_id: 'file_url',
            element: {
              type: 'plain_text_input',
              action_id: 'file_url_input',
              placeholder: { type: 'plain_text', text: 'https://example.com/file.pdf' }
            },
            label: { type: 'plain_text', text: 'File URL (optional)' },
            optional: true
          },
          {
            type: 'input',
            block_id: 'tags',
            element: {
              type: 'plain_text_input',
              action_id: 'tags_input',
              placeholder: { type: 'plain_text', text: 'dashboard, mockup, orca' }
            },
            label: { type: 'plain_text', text: 'Tags (optional)' },
            optional: true
          },
          {
            type: 'input',
            block_id: 'description',
            element: {
              type: 'plain_text_input',
              action_id: 'description_input',
              multiline: true,
              placeholder: { type: 'plain_text', text: 'Optional description' }
            },
            label: { type: 'plain_text', text: 'Description (optional)' },
            optional: true
          }
        ]
      }
    });
  } catch (err) {
    boltLogger?.error(err);
    await client.chat.postMessage({ channel: command.channel_id, text: 'Could not open upload modal.' });
  }
});

// Modal submission: download Slack file, upload to Supabase, save metadata
app.view('upload_design_modal', async ({ ack, view, client, body, logger: boltLogger }) => {
  try {
    const channelId = view.private_metadata || body.user?.id;
    const teamId = body.team?.id;
    const workspace = await getOrCreateWorkspace(teamId, body.team?.name || 'Unknown Team');
    const fileName = view.state.values.file_name?.file_name_input?.value?.trim();
    const fileObj = view.state.values.file_upload?.file_upload_input?.files?.[0];
    const fileUrlInput = view.state.values.file_url?.file_url_input?.value?.trim();
    const tags = view.state.values.tags?.tags_input?.value?.trim();
    const description = view.state.values.description?.description_input?.value?.trim();

    const errors = {};
    if (!fileName) errors['file_name'] = 'Required';
    if (!fileObj?.id && !fileUrlInput) {
      errors['file_upload'] = 'Select a file or provide a URL';
      errors['file_url'] = 'Provide a URL or select a file';
    }
    if (Object.keys(errors).length) {
      await ack({ response_action: 'errors', errors });
      return;
    }

    await ack();

    await client.chat.postMessage({ channel: channelId, text: 'Uploading your file...' });

    let finalFileUrl = fileUrlInput || '';
    let slackFileId = fileObj?.id || null;

    if (fileObj?.id) {
      // Get Slack file info
      const info = await client.files.info({ file: fileObj.id });
      const slackFile = info.file;

      // Download file with bot token
      const authToken = client?.token || process.env.SLACK_BOT_TOKEN;
      const res = await fetch(slackFile.url_private, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      if (!res.ok) throw new Error('Failed to download file from Slack');
      const buf = Buffer.from(await res.arrayBuffer());

      // Upload to Supabase storage
      const stored = await uploadFileToStorage(buf, slackFile.name || fileName);
      finalFileUrl = stored.url;
    } else if (fileUrlInput) {
      // Use provided URL directly
      finalFileUrl = fileUrlInput;
      slackFileId = null;
    }

    // Save metadata compatible with retrieval
    await saveUploadedFileMetadata({
      workspace_id: workspace.id,
      user_id: body.user?.id,
      file_name: fileName,
      tags: tags || null,
      description: description || null,
      file_url: finalFileUrl,
      slack_file_id: slackFileId
    });

    await client.chat.postMessage({
      channel: channelId,
      text: '✅ File uploaded successfully! You can now ask me to fetch it by name or tags.'
    });
  } catch (err) {
    boltLogger?.error(err);
    try {
      await ack();
    } catch {}
    const channelId = view?.private_metadata || body?.user?.id;
    if (channelId) {
      await client.chat.postMessage({ channel: channelId, text: `❌ Upload failed: ${err.message}` });
    }
  }
});

const port = process.env.PORT || 3000;
app.start(port).then(() => logger.info(`Slack app listening on :${port}`));
