# Picture Perfect

Your own app for sorting, de-duplicating, naming and pruning your photos. It runs on your Mac and works directly on your photo drive — nothing is uploaded anywhere.

## Installing

1. Open this repository's **Releases** page (on the right-hand side of the repository's main page) and download **Picture-Perfect-Mac.zip** from the newest release.
2. Double-click the zip, then drag **Picture Perfect** into your **Applications** folder.
3. Open it. **The first time only**, macOS says it can't check the app for malware, because it isn't from the App Store. Click **Done**, open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to Picture Perfect.
4. If your Mac asks whether Picture Perfect may access files on a removable volume, or control Finder (used for moving deleted photos to the Trash), click **Allow**.

To update, download the newest zip and replace the app in Applications. Your settings and the catalog on your drive are kept.

The app is built for Apple silicon Macs (M1 and newer).

## Using it

**Choose your photo folder** the first time. It scans everything: dates, locations, previews. A big collection can take a while the first time; later scans only look at what's new.

**Add photos…** — choose a folder (a card, a phone export, downloads). Before anything is copied or renamed, every photo is checked against your library:

- **Exact copies** of photos you already have,
- **Look-alikes** — the same picture resized, re-saved, or sent through WhatsApp or email,
- **Repeats** inside the new folder itself.

Each one is shown next to the photo it matches. They're left out unless you click **Import anyway**. Nothing is copied until you press **Copy N photos to your drive**. If none of the photos are already in your library, it skips this step and copies straight away. The copies go into a `_Drive Preview` folder on your drive, still with their old names, and the Drive Preview tab opens so you can see what each will be renamed to.

**Drive Preview** — opens by itself whenever new photos arrive (from **Add photos…**, or when a rescan finds new files on the drive). Each photo shows its new name before anything is renamed. You can change:

- the **name** (location and event, e.g. *Bequia Regatta*)
- the **date & time** — if the camera clock was wrong, select them all, choose **Date & time…**, and set the first photo to the right time; the rest shift by the same amount and stay in order
- the **place** — search for it or click the map
- **tags**, like people's names

Do it one photo at a time, or tick several and use the buttons at the top.

**Add to group…** puts photos or videos into a group you already have (photos sharing a name, like *St. Barts Xmas NYE*) — handy for videos with odd names and wrong dates. Search for the group, choose where they fall in its timeline (they keep their order), and they get the group's name and place. It's in Drive Preview and in the photo viewer; from the viewer the file is renamed straight away. **Save & file** then renames them, files them into folders, and saves everything into the photos.

**Find matches…** — on any photo (in Drive Preview or the viewer). Tell it where to look — only photos named or tagged *college*, a year, a place, or everywhere — and it shows the closest-looking photos, best first. It looks harder than the normal duplicate check, so scans of old prints still match: sideways, faded, cropped or smaller. For each match you can **copy its date & place** to your photo (great for undated scans), or keep one and set the other aside.

**Guess date…** — on any photo without a date (in Drive Preview, or in the viewer). It finds dated photos that look like the same occasion — similar colors, light and setting — and suggests their dates, most likely first, with thumbnails so you can judge. Pick one (or adjust it) and it's saved as date only. You can narrow where it looks by tag, year or place. Works best when you have other photos from the same event; for a lone old scan it's a rough hint.

**Prune** — go through a batch and keep only the good ones. It opens right after you file photos from Drive Preview (**Prune these photos**), from the **Prune** tab for any folder, or from Browse for anything you've filtered. Photos that look blurry, too dark, overexposed, or are weaker shots of the same moment (bursts) are marked **Delete** — click to change. Click a photo to see it large and use the keys **K** keep, **D** delete, **1–5** stars, ← → to move. Deleted photos go to the Mac **Trash** (you can Put Back until you empty it); stars are saved inside the photos. Photos that are simple (not busy), colorful and well composed get a **★ Likely favorite** badge with the reason, and **Likely favorites first** sorts them to the top. Every keep/delete choice teaches it your taste — how much you care about simplicity, color, composition, sharpness and exposure — and after about 40 choices its suggestions start to follow what you actually keep. It can't judge poses or people yet; that's what your stars are for.

**People** — face recognition, entirely on this Mac. Click **Set up** once (a 15 MB download), and it finds the faces in your photos and groups the ones that look like the same person. Under **Who is this?**, type a name for each group — use a name you've used before to add them to that person, or **Check faces** to untick any that don't belong. After that, new photos of people you've named show up under **To check** ("Is this Hugh?") — **Yes to all**, or untick the wrong ones. Click a person to see their faces, remove a wrong one (×), rename, merge (rename to an existing name), or **See their photos**. Names are saved inside the photos as standard "person in image" and keyword tags, so Apple Photos, Lightroom and Windows can see them, and Browse finds them by name. New photos are checked for faces automatically when they come in. Works best on clear faces; sunglasses, profiles, tiny background faces and babies are harder.

**Browse** — all your photos by day, newest first. Search by place, year, month, rating, name or tag. When a search is on, **Edit these photos** opens all of them together — e.g. pick July 2025, click Edit, then **Name…** "New York" to put the whole month in one New York folder. Click a photo to see it large, see its details, or show it in Finder. Click **Name this day** to give every photo from a day its location and event, like *St. Barts Xmas NYE*, or **Edit photos** to fix dates, places and tags for that day.

**Duplicates** — each group of copies side by side. The best copy is marked **Keep**; click any photo to switch it. **Done** moves the extras to a `_Set aside` folder on the drive. Nothing is ever deleted — when you're happy, delete that folder yourself in Finder. Exact byte-for-byte copies can be handled all at once.

**Locations** — photos with no location, grouped by day. Where you took another photo nearby in time, it suggests that place. Otherwise, search for a place or click the map.

**Organize** — shows exactly what will change before anything happens. Press **Apply** to rename, file into folders, and save locations and dates into the photos themselves. **Undo** puts names and folders back.

Names look like:

    📁 2025.07 › 📁 2025.07 Spain › 2025.07.14 1030 Spain.jpg

One folder per month, and inside it one folder per trip or event (photos that share a name). A trip that runs into the next month stays together in the month it began. Photos with no name sit directly in the month folder. Other layouts (Year › Month, Year, No folders) and time-in-name can be switched in Organize. Names you've already written are kept. Photos without a name get their place, e.g. `2025.12.25 1432 Gustavia.jpg`.

**Year highlights** — 📁 *2025 Highlights* sits at the top of each year and holds a copy of every ★★★★★ photo from that year (or ★★★★ and up — choose in Organize). It updates itself whenever you Save, Organize or Prune: new 5-star photos are added, ones you lower or delete are taken out. The originals never move. On an APFS (Mac-format) drive the copies share the original's space and cost almost nothing; on exFAT they take real space. Highlight copies are never counted as duplicates.

**RAW + JPEG pairs** — when your camera saves the same shot twice (e.g. `DSC_0412.JPG` and `DSC_0412.NEF`), the app treats them as one photo: shown once with a **RAW+JPEG** badge, never flagged as duplicates, and always kept together — same new name with their own endings (`2025.07.14 1030 Spain.jpg` / `.nef`), same folder, and the same date, place, tags, stars and people saved into both. Delete or set one aside and the other goes with it.

## Good to know

- The app's catalog and previews live in a hidden `.photo-organizer` folder on the drive. Deleting it just makes the app rescan from scratch. On Windows this folder (and the small `.highlights.json` in each Highlights folder) shows up because Windows doesn't hide dot-folders — just leave them be.
- Works with exFAT drives shared between Mac and Windows: names and folders are Windows-safe, and the Mac's little `._` files are ignored. The app itself runs on the Mac.
- A photo's exact GPS position is never replaced; only photos without one get a location, and only when you choose it. The exact place (e.g. *Long Island City*) is kept in the photo's details and search, while folder and file names use the city (*New York City*) unless you've named the photos yourself.
- Everything matches: the date and time in the name, the date saved inside the photo, and the Created / Modified dates Finder shows. Places and tags are saved inside the photo too, so Finder search and Apple Photos can see them.
- Undo covers names and folders. Locations and dates saved into photos stay (your backup drive has the originals).
- Nothing gets a made-up date. A photo with no date (or no time) waits in Drive Preview, marked **Date needed**, until you add one — or you can choose "use file date" or "date only". Organize shows how many are waiting and takes you to them.
- Works with JPG, HEIC, PNG, TIFF, RAW, and videos (MOV, MP4 and more).


## For tinkering

The app lives in `app/`. To run it from source instead of the packaged app, double-click `Start Picture Perfect.command` (it sets up Python, ExifTool and the rest the first time). The Mac app is built automatically by GitHub Actions (`.github/workflows/build-mac-app.yml`) whenever a version tag such as `v1.0.0` is pushed; the recipe is in `packaging/`.
