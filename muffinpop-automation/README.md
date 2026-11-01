# MuffinPop automation 🧁💥

Turns your gameplay clips into YouTube videos and uploads them to
[@MuffinPoppin](https://www.youtube.com/@MuffinPoppin) automatically.

**What it does every day:**

1. Finds new clips in your recorder folders (Mobalytics, Medal, NVIDIA, Xbox Game Bar).
2. Makes a **vertical Short** (1080×1920, blurred background, last 58 seconds of the clip, which is where the big play usually is).
3. On your chosen weekday, makes a **best-of compilation** (1080p, fades between clips, chapter timestamps, thumbnail).
4. Makes a **bold thumbnail**: the most action-packed frame, punched-up colors, huge slanted text
   (white line + red punchline like "WHO DID / THIS?!"), a red arrow and circle on the action,
   the game name at the bottom and a red edge glow.
5. Writes the title, description and hashtags. Titles rotate so the channel doesn't look copy-pasted.
6. Uploads each video as private and schedules it to go public at your set time.

Clips you put in the **MuffinPop Favorites** folder are used first.

## One-time setup (Windows)

**1. Install Python and ffmpeg.** Open PowerShell and run:

```powershell
winget install Python.Python.3.12
winget install Gyan.FFmpeg
```

Close and reopen PowerShell afterwards.

**2. Get this folder onto your PC** (download the repo or `git clone` it), then in PowerShell:

```powershell
cd path\to\muffinpop-automation
pip install -r requirements.txt
copy config.example.yaml config.yaml
```

**3. Edit `config.yaml`** in Notepad. Remove clip folders you don't use and add any you do.

**4. Let it upload to YouTube** (Google calls this "OAuth"):

1. Go to <https://console.cloud.google.com/>, create a project called `MuffinPop`.
2. **APIs & Services → Library**, search **YouTube Data API v3**, click **Enable**.
3. **APIs & Services → OAuth consent screen**: choose **External**, fill in the app name and your email. Under **Test users**, add the Google account that owns the MuffinPop channel.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type **Desktop app**. Download the JSON, rename it `client_secret.json`, and put it in this folder.
5. Run `python muffinpop.py login`. A browser opens. Pick the **MuffinPop** channel when it asks which account to use.

If your other channels already have a Google Cloud project for uploads, you can reuse its `client_secret.json` and skip steps 1–4.

> ⚠️ **Private-only uploads:** YouTube locks videos uploaded through a brand-new, unaudited API project to private. If your test upload is stuck on private, submit the free
> [YouTube API audit form](https://support.google.com/youtube/contact/yt_api_form). Your existing channels' project may already be approved.
>
> **Upload quota:** the free quota allows about 6 uploads per day, which is plenty for 1 Short a day plus a weekly best-of.

**5. Try it:**

```powershell
python muffinpop.py scan      # see how many clips it finds
python muffinpop.py short     # build a Short (look in the output folder)
python muffinpop.py status
python muffinpop.py upload    # upload + schedule it
```

**6. Make it automatic** (runs every day at 3 PM; change the time if you like):

```powershell
$py = (Get-Command python).Source
$dir = (Get-Location).Path
$action = New-ScheduledTaskAction -Execute $py -Argument "muffinpop.py run" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -Daily -At 3pm
Register-ScheduledTask -TaskName "MuffinPop Daily" -Action $action -Trigger $trigger
```

## Commands

| Command | What it does |
|---|---|
| `scan` | Find new clips |
| `short` | Build today's Short(s) |
| `compile` | Build a best-of right now (ignores the weekday) |
| `upload` | Upload and schedule everything built |
| `run` | Everything above; this is what the daily task runs |
| `status` | Show clips and videos |
| `login` | Connect to YouTube |

## Tips to keep it monetizable

- YouTube can refuse to monetize channels that pump out identical videos with no human input. Every week, drop a few hand-picked clips in the Favorites folder, and now and then add a voice line or caption in your own words.
- Use royalty-free music only (Studio → **Audio library**). Set `music_file` in `config.yaml`.
- Mute or skip clips with copyrighted music playing in the background. Content ID will claim them.

## Thumbnails

Try the look on any clip:

```powershell
python thumbnails.py "C:\path\to\clip.mp4" --text "NO|WAY?!" --game Valorant
python thumbnails.py "C:\path\to\clip.mp4" --text "WHAT DID|I DO?!" --vertical
```

The `|` splits the white top line from the red punchline. Edit the phrase lists `SHORT_TEXT` and
`COMP_TEXT` at the top of `thumbnails.py` to change what it says. On Windows it uses the Impact font.

Custom thumbnails need a verified channel: verify your phone at <https://www.youtube.com/verify>.

## Branding

`branding/make_banner.py` generates `branding/muffinpop_banner.png` (2560×1440, text kept inside YouTube's safe area).
