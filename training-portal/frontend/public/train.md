---
name: train
description: Train an organisation's Vinaiak AI assistant through the Vinaiak training portal's API. Read its topic tree, write or import pages, file them under the right topics, fix pages that were split into parts, and check what the assistant will read. Use when asked to teach, train, update or organise what a Vinaiak assistant knows, including training it on a website or keeping it in sync with one.
---

# Training a Vinaiak assistant

An organisation's Vinaiak AI assistant answers only from the pages in its training portal. You train it
by adding, editing, moving and deleting those pages through the portal's API, the same one the portal's
website uses. Every page you save is read, split into passages and indexed within a minute, and the
assistant answers from it straight away.

## Setup

The portal's API is at `https://4lw55iclpbzm3p7twzkuotf76y0odhyj.lambda-url.ap-south-1.on.aws`.

You need one environment variable from the person you're working for:

- `PORTAL_TOKEN`: an API key for their organisation, starting `vtp_`. Send it as
  `Authorization: Bearer $PORTAL_TOKEN` on every call.
  - It acts as the person who made it: it can change only the folders given to them.
  - They create it in the portal, under **Topics › Connect an AI**, and can revoke it there.
  - If it's missing, ask for it. Never try to sign in to the portal or to Google yourself.
  - Treat it like a password: don't print it, write it to a file or put it in a URL.

Shell variables don't carry over between commands, so start each command that calls the API with:

```sh
api=https://4lw55iclpbzm3p7twzkuotf76y0odhyj.lambda-url.ap-south-1.on.aws
auth=(-H "Authorization: Bearer $PORTAL_TOKEN")
json=(-H "Content-Type: application/json")
```

Check the key first:

```sh
curl -sS "$api/tree" "${auth[@]}"
```

- **`200`:** the tree's `name` is the organisation you're training. It shows only the folders given
  to the person, under the path to them.
- **`401`:** the key is wrong or was revoked. Stop and ask for a new one.

## How the portal stores knowledge

- **Pages and topics:** a page's id is its path of topic names, joined by `|`, e.g.
  `Admissions|UG|Fees`.
  - The names before the last are folders.
  - A path is a page or a folder, never both: nothing goes inside a page (`409`).
- **The path is part of what the assistant reads.** Every passage is indexed with its page's path as
  context, so the path is how a passage about "₹1,00,000 per semester" is known to be about UG fees.
  - Name topics the way people ask: `Admissions|UG|Fees`, not `Misc|Page 3` or `Fees2`.
  - Keep names short, specific and in the organisation's own words.
- **Names:** not empty, no spaces around them, no `|`, no `~` (it marks parts) and no `#`. A whole id
  is at most 248 bytes.
- **Parts:** a page over about 400,000 characters is split into parts: `Fees`, `Fees~1`, `Fees~2`, and so on.
  - A part shows as a page of its own, and its name tells the assistant nothing.
  - While parts exist, `Fees` can't be saved (`409`).
  - Rename each part to what it covers. Splitting a long page into well-named pages yourself is better
    still.
- **Images and PDFs:** a page's images and PDFs, linked as `![...](https://...)`, are read and described
  when it's saved.
  - The description replaces the link's text, so the assistant learns what's in them.
  - A file the saved page links to already isn't described again: it keeps its saved description,
    whatever text its link has now, such as alt text from scraping the page again.
  - A file that couldn't be read keeps its link's text with a space after it, and the page still
    saves. The next save that changes the page tries it again. Leave that space, or it's taken as
    your text for the file.
  - To correct a description, edit the link's text and save with `force_override: true`. Ending a
    link's text with a space, or emptying it, with `force_override` has the file described again,
    for when it changed at the same address. Use `force_override` only for edits like these, as it keeps every link's text as
    you sent it.
  - A person's photo is described by name and designation, taken from the text around it. So put a
    photo next to the name and role it shows.
- **Reading a page back** rebuilds its text from the indexed passages. Its images come back already
  described, and blank lines are normalised. When editing, start from what you read back.
- **Watchers** keep pages in sync with the web. Only a person can set one up, in the portal (see
  "Pages that change: suggest a watcher"), and the portal checks them every hour and saves what
  changed itself. Clocks, today's date, "5 minutes ago", visitor counters and the like don't count
  as changes.
  - **In `/tree`,** a watched node has `watcher: "file"`, a page that follows one web page and is
    imported again when it changes, or `watcher: "directory"`, a folder that follows a list of links
    on a web page. Each new link is imported as a page in it, and a page whose link goes is deleted.
    Its pages have `by_watcher: true`, and may be `"file"` watchers too.
  - **`GET /watchers?id=ID`** on a watched node says what it follows: its `url`, and a directory
    watcher's `levels`, the CSS selector of the list on its page, then on each page those links lead
    to, with how many links each follows (`limit`, from the bottom if `reverse`). You can read
    watchers, but not create, edit or stop them.
  - **A page with `by_watcher` can't be edited or deleted:** `PUT` and `DELETE /files` get `409`.
    The watcher deletes it itself once its link goes.
  - **Editing a `"file"` watcher's page stops the portal keeping it in sync.** So does deleting it.
    Ask the person first.
  - Renaming moves a watcher with its page or folder. Pages you add to a watched folder are left alone.

## Costs

Every save runs AI models on the organisation's account, so don't save more than needed.

| Call | Runs |
| --- | --- |
| Create or edit a page | Describes the images and PDFs new to it, then splits and indexes the page. Unchanged, nothing runs |
| Rename a page | Splits and indexes it again (no descriptions) |
| Rename a folder | Splits and indexes every page under it again |
| Read, list, scrape, create a folder, delete | No model |

- **Make all your changes to a page, then save it once.** Don't save to "try" text.
- **Don't save a page whose text didn't change.**
- **Get the names right before creating pages.** Renaming re-indexes, and a folder rename re-indexes
  everything under it.
- **Plan before writing.** Read the tree, decide the structure, then write.

## The API

All bodies are JSON. Errors come back as `{"error": "..."}`. Build bodies with `jq` so markdown's quotes
and newlines are escaped.

| Call | Does | Returns |
| --- | --- | --- |
| `GET /tree` | Every topic the key may see | `{name, file, watcher?, by_watcher?, outside?, assigned?, children: [...]}`; `file` means it's a page, else it's a folder |
| `GET /files?id=ID` | A page | `{id, markdown, source?}` |
| `POST /files` `{id, markdown, source?}` | Creates a page; `409` if it exists | `201 {ids}` |
| `PUT /files` `{id, markdown, source?, force_override?}` | Replaces a page's text; `404` if missing, `409` if `by_watcher`. The same text and source change nothing and cost nothing | `{ids}` |
| `POST /files/rename` `{from, to}` | Moves a page; `409` if `to` exists | `{ids}` |
| `DELETE /files?id=ID` | Deletes a page (its parts stay); `409` if `by_watcher` | `204` |
| `POST /folders` `{id}` | Creates an empty folder | `201` |
| `POST /folders/rename` `{from, to}` | Moves a folder with everything in it | `{ids}` |
| `DELETE /folders?id=ID` | Deletes a folder with everything in it | `204` |
| `GET /scrape?url=URL` | A web page's main content as markdown. Saves nothing | `{markdown, title?, source}` |
| `POST /files/uploads` `{id, files: [{name, type, size}]}` | Where to upload PDFs and images for the page `id`, before saving it. `type` is `application/pdf`, `image/png`, `image/jpeg`, `image/webp` or `image/gif`; `size` is in bytes, up to 20 MB; up to 20 files | `{uploads: [{url, headers, public_url}]}`, one for each file, in order |
| `GET /watchers?id=ID` | What a watched node (`watcher` in `/tree`) follows; `404` if it isn't one | `{id, kind, url, levels?: [{selector, limit?, reverse}], pages?, checked_at?, error?}` |

- **Keys reach only these calls.** The portal's account, key and admin calls, and creating, editing
  or stopping a watcher, need a person signed in.
- **`outside: true`:** a topic above the folders given to the person, shown only as the path to them.
  Don't read, create or change anything directly in it: that gets `403`.
- **`assigned: true`:** a folder given to the person. Change anything inside it, but don't rename or
  delete the folder itself: that gets `403`.
- **`ids`:** the ids saved. The first is the page; any after it are parts that need names (see below).
- **`source`:** where the text came from, such as the page `/scrape` read. It's kept with the page.

Examples:

```sh
# The tree
curl -sS "$api/tree" "${auth[@]}" | jq .

# A page (encode the id: it has `|` and spaces)
curl -sS -G "$api/files" --data-urlencode "id=Admissions|UG|Fees" "${auth[@]}" | jq -r .markdown

# Create a page from a file
jq -n --arg id "Admissions|UG|Fees" --rawfile markdown fees.md --arg source "https://example.edu/fees" \
  '{id: $id, markdown: $markdown, source: $source}' |
  curl -sS -X POST "$api/files" "${auth[@]}" "${json[@]}" --data-binary @- --max-time 900

# Edit: the same body, with PUT
# Rename
jq -n '{from: "Admissions|UG|Fees~1", to: "Admissions|UG|Hostel fees"}' |
  curl -sS -X POST "$api/files/rename" "${auth[@]}" "${json[@]}" --data-binary @- --max-time 900

# Import a web page
curl -sS -G "$api/scrape" --data-urlencode "url=https://example.edu/admissions" "${auth[@]}"

# Upload a PDF for a page, then link it from that page's markdown by its public_url
file=fee-structure.pdf
up=$(jq -n --arg id "Admissions|UG|Fees" --arg name "$file" --argjson size "$(wc -c < "$file")" \
    '{id: $id, files: [{name: $name, type: "application/pdf", size: $size}]}' |
  curl -sS -X POST "$api/files/uploads" "${auth[@]}" "${json[@]}" --data-binary @- | jq '.uploads[0]')
headers=()
while IFS= read -r header; do headers+=(-H "$header"); done \
  < <(jq -r '.headers | to_entries[] | "\(.key): \(.value)"' <<<"$up")
curl -sS --fail -X PUT "${headers[@]}" --data-binary @"$file" "$(jq -r .url <<<"$up")"
jq -r .public_url <<<"$up"
```

- **Timing:** a save takes from a few seconds to a few minutes, longer with many images, so give it a
  long timeout. Don't retry a save that's still running: the second would race the first.
- **Concurrency:** save one page at a time.
- **Files:** upload a file only when the person gives you one, such as a PDF or a photo, that isn't
  on the web. Link a file that's already online by its own URL instead.
  - `PUT` each file to its `url` within 15 minutes, with exactly its `headers`, and the same type and
    size you asked for. Anything else gets `403`.
  - Then link it in the page's markdown, `[Fee structure 2026](public_url)`, or `![…](public_url)`
    for an image, and save the page with the same `id`. The save reads and describes it.
  - Anyone with the link can open the file.
  - The file belongs to that page: deleting the page deletes it. Link it from that page only; for
    another page, upload it again for that page's `id`.

## Errors

| Status | Means | Do |
| --- | --- | --- |
| `400` | A bad id or name, an empty page, or a bad URL | Fix the input |
| `401` | The key is wrong or was revoked | Stop and ask for a new key |
| `403` | A call a key can't make, a path outside the person's folders, renaming or deleting a folder given to them, or the org has no OpenRouter or Firecrawl key yet (the error names it) | Stop and tell the person |
| `404` | No such page | Check the id against `/tree`; create it instead |
| `409` | The id is taken, it's inside a page, a page and a folder would share it, or the page has unnamed parts (the error names them) | Rename the parts, or pick another id |
| `422` | The page is too large to index | Split it into several pages |
| `429` | The web importer is rate limited | Wait, then retry once |
| `502` | An AI model or the web importer failed | Retry once; then report it |

## How to train

1. **Read `/tree`.** It checks the key, and shows what's there before you add anything.
2. **Gather the material.**
   - For a web page, use `/scrape`, then clean the markdown: drop navigation, cookie notices, "share"
     links and repeated headers and footers.
   - Keep facts, tables, dates, contacts, and image and PDF links. A linked PDF's contents get read
     too.
   - Keep the page's `source`.
3. **Plan the structure.**
   - One page per topic people ask about, under folders that read as a path, like
     `Admissions|UG|Fees` or `Departments|Mining Engineering|Faculty`.
   - A page can't hold other pages. A section's own overview goes inside its folder, like
     `Departments|Mining Engineering|About`.
   - Reuse the folders that exist.
   - Merge into an existing page rather than making a near-duplicate.
   - Show the plan to the person and get a yes before writing, especially for renames and deletes.
   - Training on a whole website, or a big part of one, has its own steps: see below.
4. **Write each page well.**
   - Open with one line saying what the page covers.
   - Use headings that name things, and state facts plainly, with years and dates where they matter
     ("Fees for 2026–27").
   - Use tables for fees, dates and lists of people.
   - Write in the organisation's voice.
   - Don't invent anything. If a fact is missing, leave it out and say so in your report.
5. **To edit, read first.** `GET` the page, change only what needs changing, and `PUT` it back in one
   save.
6. **Handle parts.** If a save returns more than one id, rename each part (`Fees~1`, ...) with
   `/files/rename` to a name for what it covers. Read each one first to see what it holds.
7. **Check your work.** `GET` each saved page and confirm the text is right and its images are
   described. `GET /tree` and confirm the structure is what you planned.
8. **Report** what you created, edited, renamed and deleted, with their ids, and anything you couldn't
   do or verify.

## Training on a website

When asked to train on a whole website, or a big part of one, ask and plan before saving anything.

1. **Ask which sections they want.** A whole site can run to hundreds of pages, and much of it, such
   as news, events, tenders or archives, may not matter to the person. Every page saved costs model
   runs.
   - List the site's main sections, from its navigation or `/sitemap.xml`, and ask which to train
     on.
   - Don't go beyond the sections they pick without asking.
2. **Find what's already imported, and what's watched.** Read `/tree`, then `GET` each page to learn
   its `source`, and `GET /watchers?id=` each node with `watcher` to learn its `url`.
   - A page whose `source` is one of this site's URLs was already imported.
   - A watcher's `url` is its own: don't import it. Nor, for a directory watcher, the pages its list
     there links to: it imports them itself, and leaves out those past its `limit` on purpose. Don't
     suggest another watcher for them either.
   - Compare URLs loosely: ignore `http` vs `https`, `www.`, a trailing `/`, and `#…`.
3. **List the site's pages in those sections.** Scrape each section's index page and collect its
   links, or take them from the sitemap. Leave out duplicates, login pages and pages with nothing to
   learn. Keep what you scrape: you'll write the pages from it, so don't scrape them twice.
   - Lists that grow, such as notices, and pages updated in place, such as important dates, are
     better as watchers: suggest them instead of importing them (see "Pages that change").
4. **Show the plan and wait for a yes.** It names:
   - **Left as they are:** the pages already imported from this site, with their ids and sources,
     and its watchers, with their URLs. Offer to refresh the pages if the site may have changed, but
     don't by default; watchers keep theirs fresh.
   - **To create:** each new page's id, and the URL it comes from.
   - **The tree** it leaves, with new and existing topics marked.
   - **Skipped:** the URLs left out, and why.
   - **Suggested watchers:** for the person to set up in the portal, each with its kind, id and URL.
   - **How many saves** it takes.

   For example:

   ```text
   Train on example.edu: Admissions and Departments (12 saves)

   Left as they are (already imported or watched):
     Admissions|UG|Fees                   https://example.edu/admissions/ug/fees
     Admissions|Notices                   watches https://example.edu/admissions/notices

   To create:
     Admissions|PG|Fees                   https://example.edu/admissions/pg/fees
     Departments|Mining Engineering|About https://example.edu/departments/mining
     ...

   Tree:
     Admissions
       UG
         Fees                             (exists)
       PG
         Fees                             (new)
     Departments
       Mining Engineering
         About                            (new)

   Skipped:
     https://example.edu/news/...         not in the sections you picked
     https://example.edu/login            nothing to learn

   Suggested watchers (you set these up in the portal; I'll walk you through it):
     Admissions|Circulars  directory      https://example.edu/admissions/circulars
   ```

5. **Then follow "How to train"**, one page at a time, in the plan's order. If something in the plan
   changes as you go, such as a page that turns out empty or a better name, say so in your report.

## Pages that change: suggest a watcher

You can't create watchers: they spend the organisation's credits every hour, so only a person signed
in to the portal can set one up. A key can only read them, with `GET /watchers?id=`; creating,
editing or stopping one gets `403`. But a page imported once goes stale when the site changes, so
for pages that change, suggest a watcher and walk the person through it.

- **A directory watcher** suits a list of links that grows, such as notices, circulars,
  announcements, events or tenders. Each new link on it becomes a page in its folder, and a page whose
  link goes is deleted. A link to a PDF or an image becomes a page of what's in it, read by a model.
- **A file watcher** suits one page updated in place, such as fees or important dates.
- **Don't import pages a watcher will import,** nor suggest a watcher for what one already follows.
  Yours would be duplicates. Read the watchers in `/tree` first.
- **Suggest its name and place** as you would a page's, such as a directory watcher `Notices` under
  `Admissions`, following `https://example.edu/admissions/notices`.

Walk them through it:

1. In the portal's **Topics**, select the folder it goes in and click **New watcher inside**, or, at
   the top level, **New watcher**.
2. Choose **File watcher** or **Directory watcher**, then enter its name and web address.
3. **A file watcher** is then done: **Import and watch** imports the page now.
4. **A directory watcher** also needs a **Selector of the list**, which picks out the part of the page
   that holds the links. To get one without knowing HTML, they use the SelectorGadget browser
   extension:
   1. Install it from https://selectorgadget.com/.
   2. Open the web page with the list, and click the extension's icon.
   3. Click one link in the list. It turns green, and the others it picks up turn yellow.
   4. Click anything highlighted that isn't in the list, such as a menu link, to leave it out. It turns
      red. Repeat until only the list's links are highlighted.
   5. Copy the selector shown in the bar at the bottom, such as `.notice-list a`, into the portal.

   When the list is split over pages, such as a notices page linking to one page per year, each
   with that year's notices, they click **Add a level** and give a selector for the list on those
   pages too, found the same way on one of them. Each level's links lead to the pages the next
   level reads, and the last level's links are the ones that become pages. A watcher reads at most
   50 pages for links, all levels after the first together, every hour.
5. **Find links** shows how many links the selectors find, and the first ten. If they're wrong, go
   back to step 4. A watcher follows at most 200 links.
6. **Follow only**, under each level's selector, suits a long list, like notices: only that many of
   its links are followed, **From the top**, or **From the bottom** for a list with the newest last.
   At the last level, only that many become pages, and a page whose link falls out of them is
   deleted, so the folder keeps the latest. At a level above, only that many of its links are read
   for the next level's list, such as the newest 2 year pages: a year that falls out has its pages
   deleted too. Suggest a number, such as 20, when the list is long. Empty follows all.
7. **Watch pages for changes** is for pages that are edited after they're posted: that many pages,
   from the top or the bottom of the links the last level follows, are imported again when they
   change. It checks each of them every hour too, which costs more, so leave it at 0 otherwise, or
   keep it small, such as 5.
8. **Watch** starts it. The pages appear in the folder as they're imported.

**Edit** in a directory watcher's panel changes how many links each level follows, and the watching,
later; the list checks again at once. Its address and selectors stay: to follow another list, they
delete it and create a new one.

## Ask the person first

- **Before training on a whole website,** or a big part of one: which sections, then the plan (see
  "Training on a website").
- **Before deleting** any page or folder. A deleted page is forgotten at once and can't be restored.
- **Before renaming a folder** with many pages: it re-indexes all of them.
- **Before editing or deleting a watched page** (`watcher` in `/tree`): it stops following its web
  page.
- **When the material conflicts**, such as two fee figures for the same year. Don't pick one yourself.
- **Before adding personal details** about people beyond what the organisation already publishes.
