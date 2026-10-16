# DropLink v2 — Setup Guide (Google Drive storage, no credit card)

Files are stored in a **"DropLink Files"** folder in your Google Drive (15 GB free).
Emails are sent from your Gmail. The app runs free on Cloudflare Pages + D1.
**No R2, no card needed.** Time: about 20 minutes, one time only.

| Folder | Purpose |
|---|---|
| `public/` | Web pages (Send, My transfers, Download page) |
| `functions/` | Server code (runs on Cloudflare) |
| `apps-script/Code.gs` | Google bridge — paste into Google Apps Script |

---

## Step 1 — Google Apps Script (the bridge to Drive + Gmail)
1. Open **script.google.com** (logged in with your Gmail) → **New project** → rename to **DropLink Bridge**.
2. Delete the sample code and paste everything from `apps-script/Code.gs`.
3. On line `const SECRET_KEY = '...'` replace the text with your own long random text,
   e.g. `pei-dl-8f3k29xq71zz`. **Write it down** — you need it in Step 4. Click 💾 Save.
4. Left side → **Services (+)** → choose **Drive API** → **Add**. *(Makes sure Drive access is switched on.)*
5. In the toolbar, choose function **setup** → **Run**.
   - Google asks for permission → **Review permissions** → choose your account.
   - If you see *"Google hasn't verified this app"* → **Advanced** → **Go to DropLink Bridge (unsafe)** → **Allow**.
     (This is normal — it's your own script.)
   - You'll get an email "DropLink is connected" and a **DropLink Files** folder appears in your Drive.
6. **Deploy → New deployment** → ⚙️ select type **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - **Deploy** → copy the **Web app URL** (ends with `/exec`). You need it in Step 4.

> If you ever edit the script later: **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**.

## Step 2 — Put the code on GitHub
Create a repo **DropLink** and upload everything in this zip, keeping the folders.

## Step 3 — Create the database (D1) — free, no card
Cloudflare dashboard → **Storage & databases → D1 SQL database** → **Create database** → name `droplink-db` → **Create**.

## Step 4 — Create the Pages project
1. **Workers & Pages → Create → Pages → Connect to Git** → choose the DropLink repo.
2. Project name `droplink` · Framework **None** · Build command **empty** · Build output directory **`public`** → **Save and Deploy**.
3. Project → **Settings → Bindings → Add → D1 database** → Variable name **`DB`** → select `droplink-db` → Save.
4. **Settings → Variables and Secrets → Add** (Production):

| Name | Type | Value |
|---|---|---|
| `ADMIN_PASSWORD` | Secret | your login password for DropLink |
| `SCRIPT_URL` | Text | Web app URL from Step 1 |
| `SCRIPT_KEY` | Secret | the SECRET_KEY text from Step 1 |
| `SENDER_NAME` | Text | Musfikur Rahman |
| `CLEANUP_KEY` | Secret | any random text *(optional, Step 6)* |

5. **Deployments → ⋯ on the latest → Retry deployment** (settings apply only after a new deploy).

## Step 5 — Test
1. On the office cable network open `https://droplink.pages.dev/api/ping` → should show `{"ok":true,...}`.
2. Open `https://droplink.pages.dev` → log in → **My transfers** should show *"Google Drive: X GB used of 15 GB"*.
3. Send a small test file to yourself.

## Step 6 (optional) — Daily auto-cleanup
Expired files are deleted from Drive whenever you open **My transfers**. For hands-off cleanup, add to your
`supabase-keepalive` GitHub Action:
```yaml
      - name: DropLink cleanup
        run: curl -fsS "https://droplink.pages.dev/api/cleanup?key=${{ secrets.DROPLINK_CLEANUP_KEY }}"
```

---

## Good to know
- **Don't rename or move files inside the "DropLink Files" Drive folder** — the app finds them by ID. Deleting there is OK (link just stops working for that file).
- Drive's 15 GB is shared with Gmail & Photos. The app checks free space before every upload.
- Uploads: 16 MB pieces, 3 files at a time, auto-resume after a network drop.
- Receivers never see Google — they download from your droplink.pages.dev link, no login needed.
- Gmail sends about 100 emails per day on a free account; the link always works without email.
- Your Google files stay private: the Drive folder is not shared publicly; downloads go through DropLink only.

## Troubleshooting
| Message | Fix |
|---|---|
| "Google Apps Script did not answer correctly" | Deployment must be **Who has access: Anyone**; `SCRIPT_URL` must end with `/exec` |
| "Invalid SCRIPT_KEY" | `SCRIPT_KEY` in Cloudflare must exactly match `SECRET_KEY` in the script |
| "Server not configured: add the DB binding" | Check binding name is `DB`, then Retry deployment |
| Drive space not showing | Do Step 1.4 (add Drive API service) and redeploy the script as a **New version** |

Developed by Musfikur Rahman | Copyright © 2026
