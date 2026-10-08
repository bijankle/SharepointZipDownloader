# PDF Prep for Project Library

A single web page (plain HTML and JavaScript, no server, no build step) that prepares engineering PDFs (P&IDs, lists,
datasheets) for the Project Library app in bijankle/ProjectLibrary. Everything happens in your browser. Files go nowhere
except to GitHub, and only when you press Upload.

**WHAT IT DOES**

You paste SharePoint links (or document numbers, once the register is loaded) and press Download all. Your browser
downloads each file with the SharePoint sign in you already have, and the page watches the download folder. It sees
each file arrive, shows how much has arrived, checks that it really is a PDF (not a saved sign in or "access denied"
page), and marks the link Downloaded or Failed with the reason in plain words: a sign in page opened, nothing arrived,
SharePoint sent a web page, or the download stopped part way. Failed links are tried once more at the end. If several
fail in a row without a file arriving, it stops and asks you to sign in, then carries on where it stopped. The progress
bar counts finished files, the list scrolls with the current file, and at the end one zip of all the downloaded files
is saved, with download-report.csv (every link, its status and the reason) inside. You can also drop PDFs, whole
folders or zip files straight from the OneDrive synced library.

Each file name is read as NUMBER_REV.pdf (for example 2000-F00-LST-EL-20002_0.pdf). With the document register loaded,
the number, revision and title come from the register instead, matched by exact file name. Anything can be corrected in
the table.

**SETTING UP THE DOWNLOAD FOLDER (ONCE)**

A web page cannot see the browser's downloads, so it watches the folder they are saved in. Edge and Chrome don't allow
a page to watch the Downloads folder itself, only a folder inside it. Make a folder such as Downloads\SharePoint Prep,
then in Edge open Settings, Downloads, Location, Change and choose it (in Chrome: Settings, Downloads, Location), with
"Ask me what to do with each download" turned off. On the page press Choose download folder, pick the same folder and
press Allow. Folder watching needs Edge or Chrome on a computer; other browsers fall back to dropping the files in.

For every PDF the original is kept exactly as it is. A reading copy is made for Claude: each page is drawn at about
110 dpi, saved as a JPEG at the quality you choose (default 0.5), and rebuilt into a PDF with the words kept as hidden,
searchable text. A clean CAD export that is already smaller than a picture copy is used as it is. The reading copies are
combined into batch-1.pdf, batch-2.pdf and so on, each under the size limit (default 25 MB), each with a contents page
listing document numbers, revisions and page ranges. A document is only split across batches when it is bigger than the
limit on its own, and its parts are labelled "part 1 of 3, its pages 1 to 40" and so on.

Results come out three ways. The zip of downloaded files holds every file exactly as downloaded plus download-report.csv.
The reading package zip holds batches/, manifest.json and download-report.csv. Upload to GitHub
puts each original in uploads/ as NUMBER_RevREV.pdf with its note NUMBER_RevREV.json ({number, rev, uploaded, file,
title}, the format tools/ingest_uploads.py expects) and the batches and manifest in claude-batches/YYYY-MM-DD/, all in
one commit, so the ingest Action runs once. Files over 95 MB are skipped for GitHub with a message and stay in the zip.

**WHY THERE IS NO MICROSOFT SIGN IN ON THE PAGE**

A web page can only read SharePoint itself through an Azure app registration that IT approves. Without that, the page
asks the browser to download each link, the same as clicking it, and watches the download folder to check the result.
The first time, the browser may block this as pop ups:
click the blocked pop up icon in the address bar and choose Always allow for this site.

**THE GITHUB TOKEN**

Make a fine grained token at https://github.com/settings/personal-access-tokens/new with Repository access set to Only
select repositories, bijankle/ProjectLibrary, and the permission Contents set to Read and write. Paste it in Settings.
It is kept in this browser on this device only (localStorage) and is sent only to api.github.com. Forget token removes it.

**TURNING ON GITHUB PAGES**

The page is served straight from this repository. On GitHub open bijankle/SharepointZipDownloader, then Settings, then
Pages. Under Build and deployment set Source to Deploy from a branch, choose the branch that holds these files (main once
this work is merged) and the folder / (root), and press Save. After a minute or two the page is at
https://bijankle.github.io/SharepointZipDownloader/

**FILES**

index.html is the page and its styling. app.js is the page logic. prep-worker.js makes reading copies and batches in a
background worker (pdf.js 4.10.38 and pdf-lib 1.17.1 from jsdelivr). register-worker.js reads the Excel register
(JSZip 3.10.1 from cdnjs). The register you load is saved in this browser only and is never uploaded.
