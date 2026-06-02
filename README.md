# Job Q&A Viewer

A local web app for organising and browsing your job application answers. Keep your Q&A pairs in plain `.txt` files, browse them by category, drag to reorder, and edit everything in the browser.

![Job Q&A Viewer](https://github.com/user-attachments/assets/placeholder)

## Features

- **Browse by category** — sidebar navigation with auto-categorisation based on keywords
- **Search** — filters questions and answers live
- **Edit in place** — click the pencil icon to update any answer, saved back to the source file
- **Add new answers** — via the Add button, saved to `data/answers.txt`
- **Drag to reorder** — within or across categories using the ⠿ handle
- **Configurable categories** — rename, add, delete, and reorder categories; edit auto-categorisation keywords via the ⚙️ settings modal

## Requirements

- [Node.js](https://nodejs.org/) v18 or later

## Setup

```bash
git clone https://github.com/your-username/job-qa-viewer.git
cd job-qa-viewer
npm install
```

## Adding your own data

Create `.txt` files in the `data/` folder — one file per company or topic. The app reads all `.txt` files in that directory automatically.

**File format:**

```
What is your greatest strength?

I thrive in ambiguous environments where I need to define the problem
before solving it. At my last role I...




Tell me about a time you had to influence without authority.

I was leading a cross-functional initiative with no direct reports...
```

- Questions are lines that **end with `?`** or `*`
- The answer follows immediately on the next line
- Separate Q&A pairs with **3 or more blank lines**

The sample files in `data/` (Acme Corp, Nova Labs, Meridian Health) show the expected format and can be deleted once you've added your own.

## Running the app

```bash
node server.js
```

Then open [http://localhost:3456](http://localhost:3456) in your browser.

## Project structure

```
data/               # Your Q&A text files (gitignored except sample files)
  answers.txt       # New entries added via the UI land here
  acme-corp.txt     # Sample data
  nova-labs.txt     # Sample data
  meridian-health.txt
public/
  app.js            # Frontend JavaScript
  style.css         # Styles
  assets/           # Images
index.html          # HTML skeleton
server.js           # Express server + file parsing
order.json          # Saved category assignments and sort order (gitignored)
config.json         # Saved category/rule config from Settings modal (gitignored)
```

## Customising categories

Open the ⚙️ settings modal to:
- Rename, add, or delete categories
- Reorder categories by dragging
- Edit the keywords used to auto-categorise new Q&A pairs on first load

Once a pair has been manually assigned to a category (or dragged into one), the keyword rules are no longer consulted for that pair — your manual assignments always win.

## Keeping your data private

`data/*.txt`, `order.json`, and `config.json` are all gitignored. Only the sample data files and the app code are committed. Your answers never leave your machine.

---

If this saved you time, [buy me a coffee ☕](https://buymeacoffee.com/borna761)
