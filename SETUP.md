# Touch Tools - setup, step by step

No prior programming needed. Follow the steps in order. Total time about ten minutes.

You need three things: a Windows PC, a phone or tablet, and both on the **same Wi-Fi**.

---

## Step 1 - Check Python

1. Press the **Windows key**, type `powershell`, press Enter.
2. Type this and press Enter:

```
python --version
```

3. If you see `Python 3.9` or higher, you are ready. Skip to Step 2.
4. If you see an error, open **Microsoft Store**, search for **Python**, install the newest version, then close and reopen PowerShell and try again.

> On the first install, tick the box that says **Add Python to PATH** if the installer offers it.

---

## Step 2 - Get the files

**If you downloaded a zip:** right-click it, choose **Extract All**, and pick a simple place such as `C:\touch-tools`.

**If you are using GitHub:** on the repository page click the green **Code** button, then **Download ZIP**, and extract it the same way.

Avoid running it from inside the Downloads folder with the zip still there - extract first.

---

## Step 3 - Install what it needs

1. Open PowerShell.
2. Go to the folder you extracted. The easy way: open the folder in File Explorer, click the address bar, type `powershell`, press Enter.
3. Then run:

```
pip install -r requirements.txt
```

You will see lines scrolling. Wait until it stops. If it warns about "pip is not recognised", use:

```
python -m pip install -r requirements.txt
```

---

## Step 4 - Make the settings file

In the same folder, copy `config.example.json` and rename the copy to `config.json`.

Open `config.json` in Notepad. The defaults are fine:

```json
{
  "host": "0.0.0.0",
  "http_port": 8855,
  "ws_port": 8856,
  "pin": "",
  "launch": { "notepad": "notepad.exe" }
}
```

Leave `pin` empty if you trust everyone on your Wi-Fi. Put a number in it if you do not - the phone will ask for it once.

---

## Step 5 - Start it

```
python server.py
```

The window fills with a banner, then prints the address to open, for example:

```
Connect from your tablet (same Wi-Fi):
    http://192.168.1.24:8855
```

It also draws a QR code you can scan with the phone's camera.

**The address is different on every computer.** It is your PC's own network address, so nobody else's will match yours. That is why the program prints it every time it starts - read it from the banner, do not memorise it from a guide.

Leave this window open. Closing it stops the controller.

---

## Step 6 - Allow it through the firewall

The first time, Windows will ask whether to allow Python. Tick **Private networks** and click **Allow**.

If you missed the prompt, the phone will simply fail to connect - see Troubleshooting below.

---

## Step 7 - Open it on your phone

1. Make sure the phone is on the **same Wi-Fi** as the PC.
2. Open Chrome and type the address from Step 5, `http://` included.
3. The controller appears. Drag a finger on the pad - the PC cursor should move.

**Make it feel like an app:** in Chrome tap the three dots, then **Add to Home screen**. It now opens fullscreen with its own icon.

---

## Step 8 - The two extra pages

| Address | What it is |
|---|---|
| `http://<your-ip>:8855/gesture-lab.html` | Record and label your own gestures, then download them as a file |
| `http://<your-ip>:8855/test-gesture.html` | Tells you why a shape you drew did not match |

Both are optional. The controller works without ever opening them.

---

## Step 9 (optional) - Connect your own model

Only needed if you want to describe an action in plain words instead of picking it from the list. Everything else works without this.

1. Open the controller on the phone.
2. Tap **✋ Train**.
3. In step 3 the setup is already showing under the describe box - no extra tap needed. If you closed it, tap **✨ Describe** or **⚙ AI setup**.
4. Choose **Meta Model API** - already selected - or **OpenCode Go**, or **My own endpoint**.
5. Paste the key, type the model name, tap **Save & test**.
6. Wait a moment. It either says **✓ Connected** or tells you what is wrong.

The key stays in that phone's browser. It is never written to a file and never shown again after saving. Meta Model API is called straight from the phone; OpenCode Go is passed through your own PC for that one request, because browsers block it directly - the PC never stores or logs it.

Now type what a gesture should do - "open the calculator" - and tap **Work it out**. The action is filled in for you; save the gesture as usual.

---

## Troubleshooting

**The phone cannot connect**
- Is it the same Wi-Fi? Mobile data does not count.
- Did the firewall prompt appear? If it was dismissed, open **Windows Security → Firewall & network protection → Allow an app through firewall**, find **Python**, and tick **Private**.
- Did the PC's address change? Look at the banner again - a new network means a new number.

**The cursor moves weirdly**
- Drag, do not tap-and-drag. Raise the **Sens** slider in the top bar.

**A key stays held down**
- Tap **Release all** on the controller.

**The screen strip is black**
- Tap **🖥 Show**. If the button already says **Hide**, it is on - give it a second for the first frame.
- Still black? The PC may be locked, or the window may be on a monitor the capture cannot see. Unlock it, then tap **Hide** and **Show** again.

**It works on the PC but not the phone**
- Open `http://127.0.0.1:8855` on the PC itself. If that works, the problem is the network, not the app.

**Port already in use**
- Something else is using 8855. Change `http_port` and `ws_port` in `config.json` to e.g. 8955 and 8956, and start again.

---

## Stopping and restarting

- Stop: press **Ctrl+C** in the PowerShell window.
- Start again later: open the folder, `python server.py`.

To make it start with Windows, create a Task Scheduler task that runs `python server.py` in that folder at logon. That is optional and not required for the demo.

---

## What you never have to do

- No account, no sign-in, no cloud service.
- No app to install on the phone.
- No API key - the controller works without one. A key is only needed if you later turn on the model-based gesture feature.
