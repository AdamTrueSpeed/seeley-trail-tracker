"""Make the Android launcher icons and splash pictures from the web app's icon.

    python make-icons.py        (run from android-app\\, after "npx cap add android")

The launcher icons are plain pictures at each screen density (the adaptive-icon
files Capacitor generates are removed, so its default logo is not used anywhere).
Every splash picture keeps its size and becomes black with the icon in the middle."""
import glob, os, shutil
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "android", "app", "src", "main", "res")
icon = Image.open(os.path.join(HERE, "..", "icons", "icon-512.png")).convert("RGBA")

for name, size in (("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)):
    folder = os.path.join(RES, "mipmap-" + name)
    small = icon.resize((size, size), Image.LANCZOS)
    for f in ("ic_launcher.png", "ic_launcher_round.png"):
        small.save(os.path.join(folder, f))
    fg = os.path.join(folder, "ic_launcher_foreground.png")
    if os.path.exists(fg): os.remove(fg)
shutil.rmtree(os.path.join(RES, "mipmap-anydpi-v26"), ignore_errors=True)

for path in glob.glob(os.path.join(RES, "drawable*", "splash.png")):
    w, h = Image.open(path).size
    side = min(w, h) // 3
    canvas = Image.new("RGB", (w, h), (0, 0, 0))
    canvas.paste(icon.resize((side, side), Image.LANCZOS), ((w - side) // 2, (h - side) // 2), icon.resize((side, side), Image.LANCZOS))
    canvas.save(path)
print("icons and splash pictures written")
