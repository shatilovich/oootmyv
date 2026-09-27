"""Original background track for the promo, synced to the scene timeline in promo.html.

112.5 BPM, so a beat is 0.5333 s and scene cuts land on beats:
  0-3.2 s   hook: A-minor drone, clock tick, notification ping (tension)
  3.2 s     "Не спешите платить": groove kicks in, Am-F-C-G
  18.1 s    price reveal: hit + lift to F-G
  21.3 s    end card: resolve to C major, logo chime, fade out
Usage: python3 music.py out.wav
"""
import sys
import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfilt, fftconvolve

SR = 44100
DUR = 25.0
BEAT = 60 / 112.5
N = int(SR * DUR)
L = np.zeros(N)
R = np.zeros(N)
rng = np.random.default_rng(7)


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def lp(x, f, order=2):
    return sosfilt(butter(order, f, 'low', fs=SR, output='sos'), x)


def hp(x, f, order=2):
    return sosfilt(butter(order, f, 'high', fs=SR, output='sos'), x)


def add(sig, t, gain=1.0, pan=0.0):
    i = int(t * SR)
    if i >= N:
        return
    sig = sig[:N - i] * gain
    L[i:i + len(sig)] += sig * np.sqrt((1 - pan) / 2) * 1.414
    R[i:i + len(sig)] += sig * np.sqrt((1 + pan) / 2) * 1.414


def env(n, a, d):
    """attack seconds, exponential decay time constant seconds"""
    t = np.arange(n) / SR
    e = np.exp(-t / d)
    na = max(1, int(a * SR))
    e[:na] *= np.linspace(0, 1, na)
    return e


def saw(f, n, detune=0.0):
    t = np.arange(n) / SR
    out = np.zeros(n)
    for k in range(1, 14):
        if f * k > 9000:
            break
        out += np.sin(2 * np.pi * f * (1 + detune) * k * t) / k
    return out


# ---- instruments ----
def kick(gain=1.0):
    n = int(.45 * SR)
    t = np.arange(n) / SR
    f = 48 + 110 * np.exp(-t / .035)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, .002, .12) * gain


def clap():
    n = int(.25 * SR)
    x = hp(lp(rng.standard_normal(n), 5000), 900)
    e = env(n, .001, .06)
    for d in (.0, .011, .022):  # three quick bursts
        e[int(d * SR):int(d * SR) + 200] += .6
    return x * e * .2


def hat(open_=False):
    n = int((.18 if open_ else .05) * SR)
    return hp(rng.standard_normal(n), 7000) * env(n, .001, .05 if open_ else .012) * .08


def tick():
    n = int(.05 * SR)
    t = np.arange(n) / SR
    return (np.sin(2 * np.pi * 2400 * t) + .5 * np.sin(2 * np.pi * 3700 * t)) * env(n, .0005, .006) * .35


def bass(m, dur):
    n = int(dur * SR)
    x = saw(hz(m), n) + .6 * np.sin(2 * np.pi * hz(m - 12) * np.arange(n) / SR)
    return lp(x, 700) * env(n, .004, dur * .7) * .32


def pad(notes, dur, bright=1400):
    n = int(dur * SR)
    x = np.zeros(n)
    for m in notes:
        for dt in (-.004, .004):
            x += saw(hz(m), n, dt)
    x = lp(x, bright)
    e = np.ones(n)
    a, r = int(.25 * SR), int(.35 * SR)
    e[:a] = np.linspace(0, 1, a)
    e[-r:] = np.linspace(1, 0, r)
    return x * e * .035


def pluck(m, dur=.4, g=.16):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = np.sin(2 * np.pi * hz(m) * t) + .35 * np.sin(2 * np.pi * hz(m) * 2 * t) + .12 * np.sin(2 * np.pi * hz(m) * 3 * t)
    return x * env(n, .002, .11) * g


def bell(m, dur=1.6, g=.2):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = hz(m)
    x = np.sin(2 * np.pi * f * t + 1.2 * np.sin(2 * np.pi * f * 3.5 * t) * np.exp(-t / .3))
    return x * env(n, .002, .45) * g


def whoosh(dur=.6, up=True, g=.12):
    n = int(dur * SR)
    x = rng.standard_normal(n)
    out = np.zeros(n)
    seg = 512
    for i in range(0, n, seg):  # swept band-pass in blocks
        k = i / n if up else 1 - i / n
        fc = 400 + 5000 * k ** 2
        sos = butter(2, [fc * .7, fc * 1.3], 'band', fs=SR, output='sos')
        out[i:i + seg] = sosfilt(sos, x[i:i + seg])
    e = np.sin(np.pi * np.linspace(0, 1, n)) ** 2
    return out * e * g


def thud():
    n = int(.35 * SR)
    t = np.arange(n) / SR
    f = 40 + 80 * np.exp(-t / .03)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, .001, .09)
    paper = lp(rng.standard_normal(n), 2500) * env(n, .001, .02) * .5
    return (body + paper) * .7


def b(k):
    return k * BEAT


# ---- arrangement ----
# chords: (bass midi, pad notes, arp notes)
Am = (45, [57, 60, 64], [69, 72, 76, 72])
F = (41, [57, 60, 65], [69, 72, 77, 72])
C = (48, [55, 60, 64], [67, 72, 76, 72])
G = (43, [55, 59, 62], [67, 71, 74, 71])
Cmaj = (48, [55, 60, 64, 71], [67, 72, 76, 79])

# 1) hook, beats 0-6: drone + clock tick + notification ping
drone = lp(saw(hz(45), int(b(6) * SR)) + saw(hz(52), int(b(6) * SR), .003), 500)
drone *= np.linspace(0, 1, len(drone)) ** 1.5 * .09
add(drone, 0)
for k in range(12):
    add(tick(), b(k * .5), .9 if k % 2 == 0 else .5, pan=.3 if k % 2 else -.3)
add(bell(81, g=.14), .35, pan=.2)
add(bell(88, g=.1), .47, pan=.2)
add(pad([57, 60, 64], b(6) + .3, 900), 0, .6)
add(whoosh(b(1), up=True, g=.1), b(5))

# 2) groove, beats 6-34 (7 bars): Am F C G ...
prog = [Am, F, C, G, Am, F, G]
for bar, (bm, pn, arp) in enumerate(prog):
    t0 = b(6 + bar * 4)
    add(pad(pn, b(4) + .3), t0, pan=0)
    for s in range(8):  # eighth-note bass, pumping
        add(bass(bm if s % 4 != 3 else bm + 12, b(.5) * .9), t0 + b(s * .5), .9 if s % 2 == 0 else .6)
    for bt in range(4):
        add(kick(), t0 + b(bt))
        if bt in (1, 3):
            add(clap(), t0 + b(bt), pan=.05)
    for s in range(8):
        add(hat(open_=(s % 4 == 2)), t0 + b(s * .5), pan=.35)
    if bar >= 1:  # arp enters after first bar
        for s in range(16):
            add(pluck(arp[s % 4] + (12 if bar >= 4 and s % 8 == 7 else 0)), t0 + b(s * .25), .8 if s % 2 == 0 else .55,
                pan=-.4 if s % 2 else .4)

# stamp hit on "Можно оспорить" (5.05 s), step-check blips, transition whooshes
add(thud(), 5.02)
for t, m in ((7.5, 84), (8.3, 86), (9.1, 88)):
    add(pluck(m, .3, .13), t, pan=.5)
for t in (6.0, 13.0, 17.2):
    add(whoosh(.7, up=True, g=.09), t)

# 3) price reveal, beats 34-40: hit, then F -> G lift
t0 = b(34)
add(kick(1.3), t0)
add(bell(76, 2.0, .16), t0)
add(pad(F[1] + [72], b(3) + .3, 2200), t0)
add(pad(G[1] + [74], b(3) + .3, 2600), t0 + b(3))
for s in range(12):
    add(bass(41 if s < 6 else 43, b(.5) * .9), t0 + b(s * .5), .8)
    add(hat(), t0 + b(s * .5), pan=.35)
for bt in range(6):
    add(kick(), t0 + b(bt))
    if bt % 2 == 1:
        add(clap(), t0 + b(bt))
add(whoosh(b(2), up=True, g=.13), t0 + b(4))
for s in range(8):  # snare-roll style build
    add(clap(), t0 + b(5 + s * .125), .25 + .08 * s)

# 4) end card, beat 40+: resolve on C major, chime with logo tick
t0 = b(40)
add(kick(1.4), t0)
add(pad(Cmaj[1] + [76], DUR - t0, 2000), t0, 1.2)
add(bass(36, 3.0), t0, 1.1)
for i, m in enumerate([72, 76, 79, 84]):
    add(bell(m, 2.4, .14), 21.62 + i * .09, pan=-.3 + .2 * i)
for s in range(8):
    add(pluck(Cmaj[2][s % 4], .5, .1), t0 + b(1 + s * .5), pan=.4 if s % 2 else -.4)

# ---- master ----
mix = np.stack([L, R])
# small room: decaying filtered noise IR, different per channel for width
n_ir = int(1.4 * SR)
for ch in range(2):
    ir = lp(rng.standard_normal(n_ir), 4500) * np.exp(-np.arange(n_ir) / SR / .35)
    ir /= np.sqrt((ir ** 2).sum())
    mix[ch] += .22 * fftconvolve(hp(mix[ch], 250), ir)[:N]
mix = np.tanh(mix * 1.1) / 1.1
fade = int(1.6 * SR)
mix[:, -fade:] *= np.linspace(1, 0, fade) ** 2
mix /= np.abs(mix).max() / .89
wavfile.write(sys.argv[1] if len(sys.argv) > 1 else 'music.wav', SR, (mix.T * 32767).astype(np.int16))
