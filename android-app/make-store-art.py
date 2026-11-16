"""Make the Play Store pictures in play-store\\: phone screenshots at 1080 x 1920 and the 1024 x 500 banner.

    python make-store-art.py shot1.jpg shot2.jpg ...     (screenshots taken of the app at phone shape, 9:16)"""
import os, sys
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(HERE, "play-store"); os.makedirs(OUT, exist_ok=True)
NAMES = ["1-recording", "2-saved", "3-trail-map", "4-challenges"]
for i, src in enumerate(sys.argv[1:]):
    im = Image.open(src).convert("RGB").resize((1080, 1920), Image.LANCZOS)
    im.save(os.path.join(OUT, "screenshot-%s.png" % (NAMES[i] if i < len(NAMES) else str(i + 1))))

icon = Image.open(os.path.join(HERE, "..", "icons", "icon-512.png")).convert("RGBA")
icon.convert("RGB").save(os.path.join(OUT, "icon-512.png"))
banner = Image.new("RGB", (1024, 500), (0, 0, 0)); d = ImageDraw.Draw(banner)
big = icon.resize((300, 300), Image.LANCZOS); banner.paste(big, (70, 100), big)
bold = ImageFont.truetype("arialbd.ttf", 62); mid = ImageFont.truetype("arialbd.ttf", 30)
d.text((420, 150), "Seeley", font=bold, fill=(255, 255, 255)); d.text((420, 222), "Trail Tracker", font=bold, fill=(255, 255, 255))
d.text((422, 312), "Map your own trails with your phone.", font=mid, fill=(0, 230, 118))
d.text((422, 352), "Works with no signal.", font=mid, fill=(169, 184, 198))
banner.save(os.path.join(OUT, "feature-graphic-1024x500.png"))
print(sorted(os.listdir(OUT)))
