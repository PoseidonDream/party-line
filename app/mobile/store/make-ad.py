"""The Party Line ad: a 30-second vertical video (1080×1920) in English and Turkish, made from the app's own screens
(make-ad-shots.mjs films them first) with captions, motion and music made here. Run from app/mobile/store:
    python3 make-ad.py            (needs ffmpeg, numpy and Pillow)
It writes ad/party-line-ad-en.mp4 and ad/party-line-ad-tr.mp4."""
import math
import os
import subprocess
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
AD = os.path.join(HERE, 'ad')
W, H, FPS = 1080, 1920, 30
FONT = '/usr/share/fonts/opentype/inter/Inter-{}.otf'
AMBER, INK, DIM = (255, 173, 31), (238, 238, 243), (150, 156, 172)

TEXT = {
    'en': {
        'slogan': 'Your friend group’s\nown hangout',
        'scenes': ['Chat, share and\nrun polls', 'Jump into voice\nwith one tap', '15 voice effects\njust for fun',
                   'A soundboard full\nof meme sounds', 'Plan game night\ntogether', 'Make your profile\nyours', 'Levels, streaks and\nachievements'],
        'end': 'Free · No ads · Your own server', 'where': 'On your phone and PC',
    },
    'tr': {
        'slogan': 'Arkadaş grubunun\nkendi takılma yeri',
        'scenes': ['Sohbet et, paylaş,\nanket yap', 'Tek dokunuşla\nsese katıl', 'Eğlence için\n15 ses efekti',
                   'Mim sesleriyle dolu\nbir ses paneli', 'Oyun gecesini\nbirlikte planla', 'Profilini kendine\ngöre yap', 'Seviyeler, seriler\nve başarımlar'],
        'end': 'Ücretsiz · Reklamsız · Kendi sunucunda', 'where': 'Telefonunda ve bilgisayarında',
    },
}
SHOTS = ['1-chat', '2-voice', '3-effects', '4-soundboard', '5-events', '6-profile', '7-home']
INTRO, SCENE, OUTRO, FADE = 3.0, 3.3, 3.6, 0.45   # seconds


def font(weight, size):
    return ImageFont.truetype(FONT.format(weight), size)


def ease(x):   # ease-out cubic, 0..1
    x = max(0.0, min(1.0, x))
    return 1 - (1 - x) ** 3


def background():
    """True black with a soft amber glow, like the app."""
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    glow = np.exp(-(((x - W * 0.5) / (W * 0.75)) ** 2 + ((y - H * 0.2) / (H * 0.42)) ** 2))
    glow2 = np.exp(-(((x - W * 0.15) / (W * 0.5)) ** 2 + ((y - H * 0.95) / (H * 0.3)) ** 2)) * 0.5
    img = np.zeros((H, W, 3), np.float32)
    img += np.array([6, 6, 10], np.float32)
    img += (glow[..., None] * np.array([70, 42, 6], np.float32)) + (glow2[..., None] * np.array([40, 20, 70], np.float32))
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).convert('RGBA')


def text_block(text, size, color=INK, weight='Black', spacing=1.12, align='center'):
    f = font(weight, size)
    lines = text.split('\n')
    lh = int(size * spacing)
    widths = [f.getbbox(l)[2] for l in lines]
    img = Image.new('RGBA', (max(widths) + 20, lh * len(lines) + 20), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for i, l in enumerate(lines):
        x = (img.width - widths[i]) // 2 if align == 'center' else 10
        d.text((x, 10 + i * lh), l, font=f, fill=color)
    return img


def phone(shot_path, height=1380):
    """A screenshot in a rounded phone frame with an amber edge and a shadow."""
    s = Image.open(shot_path).convert('RGBA')
    w = int(s.width * height / s.height)
    s = s.resize((w, height), Image.LANCZOS)
    r = 56
    mask = Image.new('L', s.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, height - 1], r, fill=255)
    pad = 60
    out = Image.new('RGBA', (w + pad * 2, height + pad * 2), (0, 0, 0, 0))
    shadow = Image.new('L', out.size, 0)
    ImageDraw.Draw(shadow).rounded_rectangle([pad, pad + 18, pad + w, pad + height + 18], r, fill=170)
    out.paste(Image.new('RGBA', out.size, (0, 0, 0, 255)), (0, 0), shadow.filter(ImageFilter.GaussianBlur(28)))
    glow = Image.new('L', out.size, 0)
    ImageDraw.Draw(glow).rounded_rectangle([pad - 4, pad - 4, pad + w + 4, pad + height + 4], r + 4, fill=120)
    out.paste(Image.new('RGBA', out.size, AMBER + (255,)), (0, 0), glow.filter(ImageFilter.GaussianBlur(16)))
    edge = Image.new('RGBA', out.size, (0, 0, 0, 0))
    ImageDraw.Draw(edge).rounded_rectangle([pad - 3, pad - 3, pad + w + 2, pad + height + 2], r + 3, outline=AMBER + (255,), width=3)
    out.alpha_composite(edge)
    out.paste(s, (pad, pad), mask)
    return out


def logo(size):
    return Image.open(os.path.join(HERE, '..', '..', 'web', 'icon-512.png')).convert('RGBA').resize((size, size), Image.LANCZOS)


def put(base, layer, cx, top, alpha=1.0):
    if alpha <= 0:
        return
    if alpha < 1:
        layer = layer.copy()
        layer.putalpha(layer.getchannel('A').point(lambda v: int(v * alpha)))
    base.alpha_composite(layer, (int(cx - layer.width / 2), int(top)))


def frames(lang):
    T = TEXT[lang]
    bg = background()
    shots_dir = os.path.join(AD, f'shots-{lang}')
    phones = [phone(os.path.join(shots_dir, f'{s}.png')) for s in SHOTS]
    caps = [text_block(c, 84) for c in T['scenes']]
    big_logo, word = logo(300), text_block('PARTY LINE', 132, INK, 'Black')
    slogan, endline, where = text_block(T['slogan'], 70, AMBER, 'ExtraBold'), text_block(T['end'], 46, INK, 'SemiBold'), text_block(T['where'], 42, DIM, 'Medium')

    def intro(t):
        f = bg.copy()
        a = ease(t / 0.8)
        lg = big_logo.resize((int(300 * (0.6 + 0.4 * a)),) * 2, Image.LANCZOS)
        put(f, lg, W / 2, 560 - lg.height / 2 + 150, a)
        put(f, word, W / 2, 900 + 40 * (1 - ease((t - 0.3) / 0.7)), ease((t - 0.3) / 0.7))
        put(f, slogan, W / 2, 1080 + 40 * (1 - ease((t - 0.7) / 0.7)), ease((t - 0.7) / 0.7))
        return f

    def scene(i, t):
        f = bg.copy()
        a = ease(t / 0.55)
        put(f, caps[i], W / 2, 120 + 30 * (1 - a), a)
        p = phones[i]
        drift = 14 * math.sin(t / SCENE * math.pi)   # a slow float
        put(f, p, W / 2, 400 + 120 * (1 - ease(t / 0.7)) - drift, ease(t / 0.4))
        return f

    def outro(t):
        f = bg.copy()
        a = ease(t / 0.7)
        put(f, big_logo, W / 2, 520 + 40 * (1 - a), a)
        put(f, word, W / 2, 870 + 30 * (1 - ease((t - 0.25) / 0.6)), ease((t - 0.25) / 0.6))
        put(f, endline, W / 2, 1060, ease((t - 0.6) / 0.6))
        put(f, where, W / 2, 1150, ease((t - 0.9) / 0.6))
        return f

    parts = [(INTRO, intro)] + [(SCENE, (lambda i: lambda t: scene(i, t))(i)) for i in range(len(SHOTS))] + [(OUTRO, outro)]
    # Each part overlaps the next by FADE seconds (a crossfade).
    starts, at = [], 0.0
    for d, _ in parts:
        starts.append(at)
        at += d - FADE
    total = at + FADE
    n = int(total * FPS)
    for k in range(n):
        t = k / FPS
        live = [(i, t - starts[i]) for i, (d, _) in enumerate(parts) if 0 <= t - starts[i] < d]
        if len(live) == 1:
            i, lt = live[0]
            img = parts[i][1](lt)
        else:
            (i, lt), (j, lt2) = live[0], live[1]
            img = Image.blend(parts[i][1](lt), parts[j][1](lt2), min(1.0, lt2 / FADE))
        if t > total - 0.5:   # fade to black at the very end
            img = Image.blend(img, Image.new('RGBA', (W, H), (0, 0, 0, 255)), (t - (total - 0.5)) / 0.5)
        yield img.convert('RGB').tobytes()
    return total


def music(seconds, path, sr=44100):
    """An upbeat loop (110 BPM, A minor: Am F C G): kick, clap, hats, bass, a soft pad and a pluck."""
    n = int(seconds * sr)
    t = np.arange(n) / sr
    beat = 60 / 110
    out = np.zeros(n)
    rng = np.random.default_rng(7)
    note = lambda m: 440 * 2 ** ((m - 69) / 12)
    chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]   # Am F C G
    bars = int(seconds / (beat * 4)) + 1

    def add(sig, start):
        i = int(start * sr)
        if i >= n:
            return
        j = min(n, i + len(sig))
        out[i:j] += sig[: j - i]

    kick_t = np.arange(int(0.35 * sr)) / sr
    kick = np.sin(2 * np.pi * (45 * kick_t + 90 * (1 - np.exp(-kick_t * 30)) / 30)) * np.exp(-kick_t * 9) * 0.9
    clap_t = np.arange(int(0.2 * sr)) / sr
    clap = rng.standard_normal(len(clap_t)) * np.exp(-clap_t * 22) * 0.35
    hat_t = np.arange(int(0.05 * sr)) / sr
    hat = np.diff(rng.standard_normal(len(hat_t) + 1)) * np.exp(-hat_t * 90) * 0.12
    for b in range(bars * 4):
        s = b * beat
        if s > 1.0:   # drums come in after the logo
            add(kick, s)
            if b % 2 == 1:
                add(clap, s)
            add(hat, s + beat / 2)
    for bar in range(bars):
        ch = chords[bar % 4]
        s0 = bar * beat * 4
        # pad: detuned saws, softened
        dur = beat * 4
        pt = np.arange(int(dur * sr)) / sr
        env = np.minimum(1, pt / 0.3) * np.minimum(1, (dur - pt) / 0.3)
        pad = sum(((pt * note(m) * d) % 1 * 2 - 1) for m in ch for d in (0.997, 1.003)) / 6
        pad = np.convolve(pad, np.ones(24) / 24, mode='same') * env * 0.16
        add(pad, s0)
        # bass: root, eighths
        for e in range(8):
            bt = np.arange(int(beat / 2 * sr)) / sr
            add(np.sin(2 * np.pi * note(ch[0] - 12) * bt) * np.exp(-bt * 6) * 0.38, s0 + e * beat / 2)
        # pluck arpeggio after the intro
        if s0 > 2.5:
            for e, m in enumerate([ch[0] + 12, ch[1] + 12, ch[2] + 12, ch[1] + 12] * 2):
                pt2 = np.arange(int(0.3 * sr)) / sr
                add(np.sin(2 * np.pi * note(m) * pt2) * np.exp(-pt2 * 12) * 0.13, s0 + e * beat / 2)
    fade = np.minimum(1, t / 0.6) * np.minimum(1, (seconds - t) / 1.8)
    out = np.tanh(out * fade * 1.1) * 0.85
    pcm = (out * 32767).astype(np.int16)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())


def render(lang):
    total = INTRO + SCENE * len(SHOTS) + OUTRO - FADE * (len(SHOTS) + 1)
    wav = os.path.join(AD, 'music.wav')
    music(total, wav)
    out = os.path.join(AD, f'party-line-ad-{lang}.mp4')
    ff = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                           '-i', wav, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k',
                           '-shortest', '-movflags', '+faststart', out], stdin=subprocess.PIPE)
    for fr in frames(lang):
        ff.stdin.write(fr)
    ff.stdin.close()
    ff.wait()
    os.remove(wav)
    print('made', out)


if __name__ == '__main__':
    for lang in ('en', 'tr'):
        render(lang)
