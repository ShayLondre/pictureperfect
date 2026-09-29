"""Draws the app icon: a small stack of prints over a teal tile, with sun, sea and a sail."""
import sys

from PIL import Image, ImageDraw, ImageFilter

S = 1024


def rounded(size, radius, fill):
    im = Image.new("RGBA", size, (0, 0, 0, 0))
    ImageDraw.Draw(im).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=fill)
    return im


def main(out):
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # tile with a soft vertical gradient (macOS icons sit inside ~824px with a margin)
    m, tile = 100, S - 200
    grad = Image.new("RGBA", (tile, tile))
    gd = ImageDraw.Draw(grad)
    for y in range(tile):
        t = y / float(tile)
        gd.line([(0, y), (tile, y)], fill=(int(28 + 20 * t), int(118 - 30 * t), int(112 - 22 * t), 255))
    mask = rounded((tile, tile), 185, (255, 255, 255, 255)).split()[3]
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 90), (m, m + 18, m + tile, m + tile + 18), mask)
    icon = Image.alpha_composite(icon, shadow.filter(ImageFilter.GaussianBlur(18)))
    icon.paste(grad, (m, m), mask)

    def photo(angle, dx, dy, w=520, h=420, art=False):
        card = rounded((w, h), 26, (250, 248, 242, 255))
        if art:
            inner = Image.new("RGBA", (w - 56, h - 90))
            d = ImageDraw.Draw(inner)
            iw, ih = inner.size
            for y in range(ih):
                t = y / float(ih)
                d.line([(0, y), (iw, y)], fill=(int(250 - 30 * t), int(180 - 40 * t), int(120 + 40 * t), 255))
            d.ellipse([iw * 0.58, ih * 0.16, iw * 0.82, ih * 0.16 + iw * 0.24], fill=(255, 236, 170, 255))
            d.rectangle([0, ih * 0.62, iw, ih], fill=(40, 110, 150, 255))
            d.polygon([(iw * 0.28, ih * 0.58), (iw * 0.28, ih * 0.22), (iw * 0.43, ih * 0.58)], fill=(255, 255, 255, 255))
            d.rectangle([iw * 0.18, ih * 0.58, iw * 0.46, ih * 0.64], fill=(35, 40, 48, 255))
            card.paste(inner, (28, 28), rounded(inner.size, 12, (255, 255, 255, 255)).split()[3])
        card = card.rotate(angle, resample=Image.BICUBIC, expand=True)
        sh = Image.new("RGBA", card.size, (0, 0, 0, 0))
        sh.paste((0, 0, 0, 70), (0, 0) + card.size, card.split()[3])
        sh = sh.filter(ImageFilter.GaussianBlur(14))
        x = S // 2 - card.size[0] // 2 + dx
        y = S // 2 - card.size[1] // 2 + dy
        layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        layer.paste(sh, (x + 6, y + 14), sh)
        layer.paste(card, (x, y), card)
        return layer

    icon = Image.alpha_composite(icon, photo(12, 40, -10))
    icon = Image.alpha_composite(icon, photo(-7, -30, 0))
    icon = Image.alpha_composite(icon, photo(3, 0, 20, art=True))
    if out.endswith(".icns"):
        icon.save(out, sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)])
    else:
        icon.save(out)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "icon.png")
