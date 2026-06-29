# Job Tracker

A local web app for managing your job search: browse and edit your interview Q&A answers, track applications through Notion, and get a Chrome extension that shows whether you've already applied to any job posting you're browsing.

## What it does

**Q&A tab** — Keep your interview answers in plain `.txt` files. Browse by category, filter by company, search, drag to reorder, and edit everything in the browser.

![Q&A tab](https://raw.githubusercontent.com/borna761/job-qa-viewer/main/public/assets/screenshot-qa.png)

**Tracker tab** — See all your job applications pulled from a Notion workspace, enriched with matching Gmail threads (applied confirmation, rejections, interview invites). Click any row for a detail panel showing the job description you saved and recent emails.

![Tracker tab](https://raw.githubusercontent.com/borna761/job-qa-viewer/main/public/assets/screenshot-tracker.png)

**Chrome extension** — While browsing job postings, a coloured dot on the extension icon tells you the stage at a glance (cyan = interested, blue = applied, purple = interviewing). Click to save a new job directly to Notion, or view its current status and recent emails.

| Save a new job | View tracked job |
|---|---|
| ![Extension save form](https://raw.githubusercontent.com/borna761/job-qa-viewer/main/public/assets/screenshot-popup-save.png) | ![Extension tracked view](https://raw.githubusercontent.com/borna761/job-qa-viewer/main/public/assets/screenshot-popup-tracked.png) |

## Requirements

- [Node.js](https://nodejs.org/) v18 or later
- A [Notion](https://notion.so) account with a workspace page for job tracking
- _(Optional)_ A Google Cloud project for Gmail integration
- _(Optional)_ Google Chrome for the browser extension

## Setup

### 1. Clone and install

```bash
git clone https://github.com/borna761/job-qa-viewer.git
cd job-qa-viewer
npm install
```

### 2. Notion setup

The tracker reads your applications from a Notion page with this structure:

```
My Job Search          ← top-level page (any name)
  ├── Not applied      ← stage page (→ Interested)
  ├── Active           ← stage page (→ Applied)
  ├── Interviews       ← stage page (→ Interviews)
  └── Inactive         ← stage page (→ Rejected)
```

Each stage page contains child pages, one per job. Each child page title must follow this format:

```
[🔗 link] — Role Title | Company Name
```

where `[🔗 link]` is linked to the job posting URL. The tracker extension creates these automatically when you save a job.

**Get a Notion integration token:**

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) → **New integration**
2. Give it read/write access to your workspace
3. Copy the token (starts with `ntn_…`)
4. Open your top-level job search page in Notion → **···** menu → **Connect to** → select your integration
5. Add the page ID to your `.env` (the 32-character ID in the page URL)

### 3. Gmail setup _(optional)_

Gmail enrichment matches application emails to tracked jobs automatically.

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → create a project
2. Enable the **Gmail API**
3. Create **OAuth 2.0 credentials** (Desktop app type)
4. Download the credentials — you need the Client ID and Client Secret

### 4. Create a `.env` file

```env
NOTION_TOKEN=ntn_your_token_here
NOTION_PAGE_ID=your_32_char_page_id_here

GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_client_secret
```

`NOTION_TOKEN` and `NOTION_PAGE_ID` are required for the tracker. The Google vars are optional — without them the tracker still shows Notion data but without email enrichment.

### 5. Run the server

```bash
node server.js
```

Open [http://localhost:3456](http://localhost:3456). On first run with Gmail configured, go to **http://localhost:3456/api/tracker/auth** to authorise Gmail access.

### 6. Chrome extension _(optional)_

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `extension/` folder in this repo
4. The Job Tracker icon appears in your toolbar

The extension connects to the server running on `localhost:3456`. Keep the server running while browsing jobs.

## Adding your own Q&A data

Create `.txt` files in the `data/` folder — one file per company or topic.

**File format:**

```
What is your greatest strength?

I thrive in ambiguous environments where I need to define the problem
before solving it. At my last role I...




Tell me about a time you had to influence without authority.

I was leading a cross-functional initiative with no direct reports...
```

- Lines ending with `?` or `*` are treated as questions
- The answer follows on the next line
- Separate Q&A pairs with **3 or more blank lines**

The sample files in `data/` (`acme-corp.txt`, `nova-labs.txt`, `meridian-health.txt`) show the expected format and can be deleted once you've added your own.

## How the tracker works

**Saving a job from the extension:**

1. Navigate to any job posting
2. Click the Job Tracker extension icon
3. Confirm or edit the role, company, and stage
4. Click **Save to Notion** — the extension fetches the job description and saves it as formatted blocks in Notion

**Viewing in the web app:**

- Open the **Tracker** tab at [localhost:3456](http://localhost:3456)
- Click **Refresh** to pull the latest data from Notion and Gmail
- Click any row to open a detail panel with the job description, email history, and calendar events

**Stage colours (extension icon):**

| Colour | Stage |
|--------|-------|
| Cyan | Interested / Not applied |
| Blue | Applied |
| Purple | Interviewing |
| Grey | Stale |
| Orange | Turned down |
| Red | Rejected |

## Notion page structure

The server maps your Notion stage page names to internal stages. Edit `NOTION_SECTION_MAP` in `server.js` to match your own page names:

```js
const NOTION_SECTION_MAP = {
  active:      'Applied',
  notapplied:  'Interested',
  interviews:  'Interviews',
  turneddown:  'Turned Down',
  stale:       'Stale',
  inactive:    'Rejected',
  // dontapply: intentionally absent → skipped
};
```

The key is your Notion stage page title, lowercased with every non-letter character removed (spaces, punctuation, and digits) — e.g. `Not applied` → `notapplied`, `Don't apply` → `dontapply`.

## Project structure

```
data/                   # Your Q&A text files (gitignored except samples)
  answers.txt           # New entries added via the UI land here
extension/
  background.js         # Service worker: icon updates, URL map caching
  manifest.json         # Chrome extension manifest (MV3)
  popup.html            # Extension popup UI
  popup.js              # Extension popup logic
public/
  app.js                # Q&A viewer frontend
  tracker.js            # Job tracker frontend
  style.css             # Styles
  assets/
index.html              # HTML shell
server.js               # Express server, Notion API, Gmail API, parsing
```

## Keeping your data private

`data/*.txt`, `order.json`, `config.json`, `.env`, and `gmail-token.json` are all gitignored. Only sample data files and app code are committed. Your answers, credentials, and email data never leave your machine.

## License

Released under the [MIT License](LICENSE).

---

If this saved you time, [buy me a coffee ☕](https://buymeacoffee.com/borna761)
