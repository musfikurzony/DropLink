/**
 * DropLink v2 — Google bridge (stores files in your Google Drive + sends emails from your Gmail)
 *
 * SETUP
 * 1. Change SECRET_KEY below to a long random text (same value goes in Cloudflare as SCRIPT_KEY).
 * 2. Run the function "setup" once (top toolbar → choose setup → Run) and allow the permissions.
 * 3. Deploy → New deployment → Web app → Execute as: Me · Who has access: Anyone → Deploy.
 * 4. Copy the Web app URL into Cloudflare as SCRIPT_URL.
 *
 * If you edit this code later: Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy
 * (otherwise Google keeps running the old code).
 */
const SECRET_KEY = 'CHANGE-ME-to-a-long-random-text';
const FOLDER_NAME = 'DropLink Files';

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.key !== SECRET_KEY) return out_({ ok: false, error: 'Invalid SCRIPT_KEY — it must match SECRET_KEY in the Apps Script' });

    if (data.action === 'token') {
      // Short-lived Google token so DropLink can upload/download/delete its files in Drive.
      return out_({ ok: true, token: ScriptApp.getOAuthToken(), folderId: getFolder_().getId() });
    }

    if (data.action === 'mail') {
      if (!data.to || !data.subject || !data.html) return out_({ ok: false, error: 'Missing email fields' });
      if (MailApp.getRemainingDailyQuota() < 1) return out_({ ok: false, error: 'Gmail daily email limit reached — try tomorrow' });
      MailApp.sendEmail({ to: data.to, subject: data.subject, htmlBody: data.html, name: data.name || 'DropLink' });
      return out_({ ok: true, remaining: MailApp.getRemainingDailyQuota() });
    }

    return out_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return out_({ ok: false, error: String(err) });
  }
}

function doGet() {
  return out_({ ok: true, service: 'DropLink bridge', emailsLeftToday: MailApp.getRemainingDailyQuota() });
}

// Finds (or creates) the "DropLink Files" folder in your Drive.
function getFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FOLDER_ID');
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (e) {}
  }
  const folder = DriveApp.createFolder(FOLDER_NAME);
  folder.setDescription('Files uploaded by DropLink. They are deleted automatically when a transfer expires.');
  props.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Run once from the editor: grants Drive + Gmail permission, creates the folder, emails you a test.
function setup() {
  const folder = getFolder_();
  MailApp.sendEmail(Session.getActiveUser().getEmail(), 'DropLink is connected',
    'Your DropLink bridge works.\nFiles will be stored in the Drive folder: ' + folder.getName() + '\n' + folder.getUrl());
  Logger.log('OK — folder: ' + folder.getUrl());
}
