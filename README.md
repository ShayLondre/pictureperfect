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

**Import** — the steps across the top show where you are: **1 Import → 2 Rename → 3 Organize → 4 Review**.

1. **Import:** choose a memory card, phone export or any folder. Every photo is checked against your library first.
2. **Rename:** a table of every photo — preview, current filename → **new filename (editable)**, date & time, location and size. Type straight into any new name to change it for that photo. Click a row to see it large on the left, with its size, camera, date and place; **Edit Metadata…** changes that one photo's name, date & time, tags and stars. Under **Applies to All Selected Photos**: the **Event / Collection** (e.g. *Lake Como*), the **Date & Time** of the first photo (change either to fix a camera clock — every photo moves by the same amount, keeping its order), the **Location** (search or drop a pin — it goes on photos without their own GPS; photos with GPS keep their exact spot), **Tags** (e.g. people's names, added to every selected photo) and the **Filename format** (with or without the time). **Edit Metadata…** can also set or correct one photo's location, and the Location column's **+ Add** does the same. Photos that would end up with the same name — e.g. several taken in the same minute — are numbered at the end in the order they were taken (*Lake Como 2*, *Lake Como 3*), skipping numbers already used on the drive; the table shows those exact names before anything is copied. **Album** puts the selected photos into an album already on your drive — search for it by name, place or year; they take its name and go into its folder (e.g. *2025.07 Spain*), keeping their own dates, even if they were taken weeks or years apart from the rest. To add just one photo, click it, choose **Edit Metadata…** and use **Album** there; the table shows 📁 which folder each photo is going into. Along the bottom: the **Destination** path and **Create subfolders by** (Month › Event, Year › Month, Year, none). Photos already in your library are marked and left out — see them under **Duplicates** and tick any you want anyway. There's also a grid view and a search. **Advanced Options…** has renaming on/off, leaving out duplicates, and moving the originals to the Trash after importing.
3. **Organize:** **Import N Photos** copies, renames and files everything in one go, saving dates, places and names into the photos.
4. **Review:** see where everything went, then **Prune these photos** if you like. Photos without a date wait in Drive Preview.

**Drive Preview** — holds photos that still need something before they can be filed: photos with no date, photos you imported without renaming, or new files a rescan found on the drive. Each photo shows its new name before anything is renamed. You can change:

- the **name** (location and event, e.g. *Bequia Regatta*)
- the **date & time** — if the camera clock was wrong, select them all, choose **Date & time…**, and set the first photo to the right time; the rest shift by the same amount and stay in order
- the **place** — search for it or click the map
- **tags**, like people's names

Do it one photo at a time, or tick several and use the buttons at the top.

**Add to group…** puts photos or videos into a group you already have (photos sharing a name, like *St. Barts Xmas NYE*) — handy for videos with odd names and wrong dates. Search for the group, choose where they fall in its timeline (they keep their order), and they get the group's name and place. They go into the group's folder, even when you keep their own dates. It's in Drive Preview and in the photo viewer; from the viewer the file is renamed straight away. **Save & file** then renames them, files them into folders, and saves everything into the photos.

**Find matches…** — on any photo (in Drive Preview or the viewer). Tell it where to look — only photos named or tagged *college*, a year, a place, or everywhere — and it shows the closest-looking photos, best first. It looks harder than the normal duplicate check, so scans of old prints still match: sideways, faded, cropped or smaller. For each match you can **copy its date & place** to your photo (great for undated scans), or keep one and set the other aside.

**Guess date…** — on any photo without a date (in Drive Preview, or in the viewer). It finds dated photos that look like the same occasion — similar colors, light and setting — and suggests their dates, most likely first, with thumbnails so you can judge. Pick one (or adjust it) and it's saved as date only. You can narrow where it looks by tag, year or place. Works best when you have other photos from the same event; for a lone old scan it's a rough hint.

**Prune** — go through a batch and keep only the good ones. It opens right after you file photos from Drive Preview (**Prune these photos**), from the **Prune** tab for any folder, or from Browse for anything you've filtered. Photos that look blurry, too dark, overexposed, or are weaker shots of the same moment (bursts) are marked **Delete** — click to change. Click a photo to see it large and use the keys **K** keep, **D** delete, **1–5** stars, ← → to move. Deleted photos go to the Mac **Trash** (open the Trash and drag them back out until you empty it); stars are saved inside the photos. Photos that are simple (not busy), colorful and well composed get a **★ Likely favorite** badge with the reason, and **Likely favorites first** sorts them to the top. Every keep/delete choice teaches it your taste — how much you care about simplicity, color, composition, sharpness and exposure — and after about 40 choices its suggestions start to follow what you actually keep. It can't judge poses or people yet; that's what your stars are for.

**People** — face recognition, entirely on this Mac. Click **Set up** once (a 15 MB download), and it finds the faces in your photos and groups the ones that look like the same person. Under **Who is this?**, type a name for each group — use a name you've used before to add them to that person, or **Check faces** to untick any that don't belong. After that, new photos of people you've named show up under **To check** ("Is this Hugh?") — **Yes to all**, or untick the wrong ones. Click a person to see their faces, remove a wrong one (×), rename, merge (rename to an existing name), or **See their photos**. Names are saved inside the photos as standard "person in image" and keyword tags, so Apple Photos, Lightroom and Windows can see them, and Browse finds them by name. New photos are checked for faces automatically when they come in. Works best on clear faces; sunglasses, profiles, tiny background faces and babies are harder.

**Browse** — all your photos by day, newest first. Search by place, year, month, rating, name or tag. When a search is on, **Edit these photos** opens all of them together — e.g. pick July 2025, click Edit, then **Name…** "New York" to put the whole month in one New York folder. Click a photo to see it large, see its details, or show it in Finder. Click **Name this day** to give every photo from a day its location and event, like *St. Barts Xmas NYE*, or **Edit photos** to fix dates, places and tags for that day.

**Duplicates** — each group of copies side by side. The best copy is marked **Keep**; click any photo to switch it. **Done** moves the extras to a `_Set aside` folder on the drive. Nothing is ever deleted — when you're happy, delete that folder yourself in Finder. Exact byte-for-byte copies can be handled all at once.

**Places** — a map of your photos and the place to give them a location, all working without internet.
- **The map** shows every photo that has a location, grouped into circles with a count; zoom in and they split up, and close up you see the photos themselves. Click a group to see those photos in the strip along the bottom.
- **Setting a location:** the strip starts with photos that **need a location** (newest first, by day). Click to select, Shift-click for a range, or Select all; double-click to see one large. Then search for a place (*Lake Tahoe*, *Tobago Cays*, *Florence*), pick one of **My Places**, paste coordinates (*39.0963, -120.0324*), or click the map. Drag the pin to the exact spot. On the right you'll see the country, state, county and nearest town, and the exact coordinates (with a copy button). Press **Apply to N Photos** — the GPS position (plus town, state, country and your place name) is saved into the photos. Nothing else in the photo changes.
- **How sure are you?** *Exact spot*, *Approximate* (within 100 m to 50 km — shown as a circle), or *Place only* (it was Lake Tahoe, but where exactly isn't known). Photos with an approximate location show with a dashed outline on the map, and the photo itself records how uncertain it is.
- **My Places:** name a spot (*Mom's Cabin*), add a type, tags and notes, and **Save to My Places**. After that, typing *Mom's Cabin* in search goes straight there, and it shows on the map. My Places live in the catalog on your photo drive.
- **Fixing a wrong location on many photos:** choose **Has a location** above the strip, type part of the place, folder or date in the filter (e.g. *Tahoma*, *2025.07*), **Select all**, then search or click the right spot and **Apply**. You can also click the group of photos on the map at the wrong spot. The new location replaces the old one in the photos.
- **Coordinates:** type or paste them in any search box where you pick a place — *39.0963, -120.0324*, *39.0963 N 120.0324 W*, *13°00'34.8"N 61°13'45.5"W*, or chart-plotter style *13°00.580'N 061°13.758'W*. Every photo with a location shows its place and coordinates: in the photo viewer (with **Copy** and **Show on map**), on the Tidy Up cards, when you hover a photo in the Places strip, and in the Places panel when you select photos ("This photo is at…", with **Move this pin**).
- **Copy one photo's location to others:** in the photo viewer press **Use this location for other photos…**, or in Places select a photo that has a location and press **Use this location**. The pin goes exactly where that photo is (with its place name); select the other photos and press **Apply**.
- **Suggestions:** photos taken close in time to photos that have a location are marked ≈ with that place; select them and **Use those locations**.
- **Online and offline:** with internet, Places shows the full online map — every road, street and building — and **Satellite** views, and search can look up street addresses (*Search online for …* at the bottom of the results). Without internet it switches to the offline map by itself: a built-in world map (countries, cities, main roads) plus any areas you saved. The dot next to Map / Satellite says which one you're seeing. Your photos, catalog, names and geotagging never need the internet.
- **Save an area for offline use:** zoom to the area and press ⤓ on the map (or use **Offline Maps**, which also lists presets like the Eastern Caribbean or California). It's saved on your photo drive, so it works offline and travels with your photos. **Check size** first — a town is a few MB, all of California with buildings about 1.5 GB.
- From **Tidy Up** → Location, *Find the exact spot on the map* opens the photos you selected here.

**Tidy Up** — for photos that were already on your drive before you used Picture Perfect (new photos are named and filed by Import). Browse your drive by folder, or search, and tick the photos you want — or **Select all**. Each photo shows the name it would get, and you can type over any of them. On the left, **Tidy Up N Photos** has tabs for **Filename** (one name for all selected, filename format, folders), **Date & Time** (move the whole selection, e.g. to fix a camera clock), **Location** (for photos without GPS, or replace all) and **Keywords** (keywords and album), with a live **Preview** of every current → new name. **Find & replace in names** fixes a wrong word in many names at once (e.g. *Tahoma* → *Bequia*). A place you choose under **Location** goes on **all** the selected photos, replacing any location they had (tick *Keep the location on photos that already have one* to leave those alone), and **Remove the location** takes a wrong one off completely. When a photo's name was just its town, the name follows the new place. **Save Changes** renames, moves and updates only the selected photos; **Cancel** throws away your edits, and **Undo last save** puts names and folders back. Old names are cleaned up: a short date at the start (*250515 …*) and the camera's number at the end (*JAPN2382*, *IMG_4321*, *DSC_0412*) are dropped, keeping just the event. Year Highlights settings are at the bottom of the left panel.

Names look like:

    📁 2025.07 › 📁 2025.07 Spain › 2025.07.14 1030 Spain.jpg

One folder per month, and inside it one folder per trip or event (photos that share a name). A trip that runs into the next month stays together in the month it began. Photos with no name sit directly in the month folder. Other layouts (Year › Month, Year, No folders) and time-in-name can be switched in Tidy Up. Names you've already written are kept. Photos without a name get their place, e.g. `2025.12.25 1432 Gustavia.jpg`.

**Year highlights** — 📁 *2025 Highlights* sits at the top of each year and holds a copy of every ★★★★★ photo from that year (or ★★★★ and up — choose in Tidy Up). It updates itself whenever you import, Tidy Up or Prune: new 5-star photos are added, ones you lower or delete are taken out. The originals never move. On an APFS (Mac-format) drive the copies share the original's space and cost almost nothing; on exFAT they take real space. Highlight copies are never counted as duplicates.

**RAW + JPEG pairs** — when your camera saves the same shot twice (e.g. `DSC_0412.JPG` and `DSC_0412.NEF`), the app treats them as one photo: shown once with a **RAW+JPEG** badge, never flagged as duplicates, and always kept together — same new name with their own endings (`2025.07.14 1030 Spain.jpg` / `.nef`), same folder, and the same date, place, tags, stars and people saved into both. Delete or set one aside and the other goes with it.

## Good to know

- The app's catalog and previews live in a hidden `.photo-organizer` folder on the drive. Deleting it just makes the app rescan from scratch. On Windows this folder (and the small `.highlights.json` in each Highlights folder) shows up because Windows doesn't hide dot-folders — just leave them be.
- Works with exFAT drives shared between Mac and Windows: names and folders are Windows-safe, and the Mac's little `._` files are ignored. Photos in the Mac Trash or the Windows Recycle Bin on the drive are ignored too. The app itself runs on the Mac.
- A photo's exact GPS position is never replaced; only photos without one get a location, and only when you choose it. The exact place (e.g. *Long Island City*) is kept in the photo's details and search, while folder and file names use the city (*New York City*) unless you've named the photos yourself.
- Everything matches: the date and time in the name, the date saved inside the photo, and the Created / Modified dates Finder shows. Places and tags are saved inside the photo too, so Finder search and Apple Photos can see them.
- Undo covers names and folders. Locations and dates saved into photos stay (your backup drive has the originals).
- Nothing gets a made-up date. A photo with no date (or no time) waits in Drive Preview, marked **Date needed**, until you add one — or you can choose "use file date" or "date only". Tidy Up shows how many are waiting and takes you to them.
- **Dates that don't match:** when a photo's file name says one date (e.g. *2019-03-12 Tobago Cays.jpg*) but the date saved inside it is a different day — often the day it was downloaded, copied or edited — it waits in Drive Preview marked **dates don't match**, showing both. Choose **Use** the file name's date or **Keep** the one inside, one photo at a time or for all selected at once. Differences of less than a day and a half (time zones) are ignored.
- Works with JPG, HEIC, PNG, TIFF, RAW, and videos (MOV, MP4 and more).


## For tinkering

The app lives in `app/`. To run it from source instead of the packaged app, double-click `Start Picture Perfect.command` (it sets up Python, ExifTool and the rest the first time). The Mac app is built automatically by GitHub Actions (`.github/workflows/build-mac-app.yml`) whenever a version tag such as `v1.0.0` is pushed; the recipe is in `packaging/`.
