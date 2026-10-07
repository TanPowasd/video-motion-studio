"""Original deterministic electronic orchestral score. No downloaded music or AI service.
Run after author.ts. Requires numpy/scipy in the author's Python, not inside Vmotion.
"""
from pathlib import Path
import json
import wave
import numpy as np
from scipy.signal import lfilter

ROOT = Path(__file__).resolve().parent
SR = 48000
rng = np.random.default_rng(817203)
chapters = json.loads((ROOT / 'timing.json').read_text(encoding='utf-8'))
duration = chapters[-1]['start'] + chapters[-1]['duration']
out = np.zeros((int(np.ceil(duration * SR)), 2), dtype=np.float32)
events = []

def hz(note):
    return 440 * 2 ** ((note - 69) / 12)

def add(at, length, note, amp, instrument, pan=0):
    n = int(length * SR)
    if n <= 0:
        return
    t = np.arange(n, dtype=np.float32) / SR
    f = hz(note)
    if instrument == 'strings':
        x = np.zeros(n, dtype=np.float32)
        for harmonic in range(1, 9):
            x += np.sin(2*np.pi*f*harmonic*t + .16*np.sin(t*4.2+harmonic)) / harmonic ** 1.65
        env = np.minimum(1, t/1.7) * np.minimum(1, (length-t)/1.9)
        x *= env * (.85 + .15*np.sin(t*3.1))
    elif instrument == 'choir':
        x = np.sin(2*np.pi*f*t + .25*np.sin(2*np.pi*f*2*t))
        x += .18*np.sin(2*np.pi*f*3*t)+.09*np.sin(2*np.pi*f*5*t)
        x *= np.minimum(1,t/2.5)*np.minimum(1,(length-t)/2.0)
    elif instrument == 'bell':
        x = np.sin(2*np.pi*f*t)*np.exp(-t*1.8)
        x += .4*np.sin(2*np.pi*f*2.01*t)*np.exp(-t*3.0)
        x += .2*np.sin(2*np.pi*f*3.99*t)*np.exp(-t*4.3)
        x *= np.minimum(1,t/.008)
    elif instrument == 'piano':
        x = np.sin(2*np.pi*f*t)*np.exp(-t*1.25)+.28*np.sin(2*np.pi*f*2*t)*np.exp(-t*2.5)
        x += .12*np.sin(2*np.pi*f*3*t)*np.exp(-t*4)
        x *= np.minimum(1,t/.004)
    elif instrument == 'bass':
        x = (np.sin(2*np.pi*f*t)+.12*np.sin(2*np.pi*f*2*t))*np.minimum(1,t/.03)*np.exp(-t*.9)
    elif instrument == 'drum':
        phase = 2*np.pi*(38*t + 65*(1-np.exp(-t*18))/18)
        x = np.sin(phase)*np.exp(-t*5)+rng.normal(0,.12,n).astype(np.float32)*np.exp(-t*12)
        x *= np.minimum(1,t/.003)
    elif instrument == 'air':
        x = rng.normal(0,1,n).astype(np.float32)
        x = lfilter([.03], [1,-.97], x).astype(np.float32)
        x *= np.sin(np.pi*t/length)**2
    else:
        raise ValueError(instrument)
    idx = int(round(at*SR))
    end = min(len(out), idx+n)
    if end <= idx or idx < 0:
        return
    x = x[:end-idx]*amp
    out[idx:end,0] += x*np.sqrt((1-pan)*.5)
    out[idx:end,1] += x*np.sqrt((1+pan)*.5)
    events.append({'at':round(at,4),'duration':length,'midi':note,'instrument':instrument,'amplitude':amp,'pan':pan})

progressions = [
    [[38,57,64,69],[38,53,60,65]],
    [[38,53,57,64],[34,53,58,65],[41,57,60,67],[36,55,60,64]],
    [[38,53,57,64],[34,53,58,65],[41,57,60,67],[36,55,60,67]],
    [[38,53,56,63],[34,51,58,64],[37,52,59,65]],
    [[38,50,57,65],[34,53,58,65],[36,55,60,67],[38,57,62,69]],
    [[34,53,58,65],[41,57,60,67],[36,55,60,64],[38,53,57,64]],
    [[38,54,57,64],[43,55,59,66],[34,53,58,65],[45,57,61,68]],
    [[38,54,57,64],[43,55,59,66],[38,54,57,62]],
]
levels = [.06,.085,.08,.045,.10,.065,.115,.08]
for chapter in chapters:
    mode=chapter['mode']; start=chapter['start']; length=chapter['duration']
    chords=progressions[mode]; level=levels[mode]
    step=6.4 if mode!=4 else 4.8
    for j,local in enumerate(np.arange(0,length-1,step)):
        chord=chords[j%len(chords)]; length_note=min(step+2.2,length-local)
        for k,note in enumerate(chord[1:]):
            add(start+local,length_note,note,level/(1+k*.3),'strings',[-.6,.2,.65][k])
            if mode in (1,5,6,7):
                add(start+local,length_note,note+12,level*.18,'choir',[-.35,.4,0][k])
        if mode!=3:
            add(start+local,min(4,length-local),chord[0],level*.7,'bass')
    if mode in (1,2,4,5,6):
        interval=.8 if mode!=4 else .4
        for j,local in enumerate(np.arange(1.6,length-2,interval)):
            chord=chords[int(local/step)%len(chords)]
            note=chord[1+j%3]+12+(12 if j%7==0 else 0)
            add(start+local,2,note,level*(.3 if mode!=4 else .25),'bell',np.sin(j*1.2)*.7)
    if mode in (4,6):
        for j,local in enumerate(np.arange(0,length-1,1.6)):
            add(start+local,1.6,38,level*1.4,'drum',.08*np.sin(j))
            if j%2==1:
                add(start+local+.8,.7,42,level*.4,'drum',-.25)
    if mode in (0,5,7):
        melody=[69,76,74,72,69,65,67,69] if mode!=7 else [69,76,74,73,69,66,64,62]
        for j,note in enumerate(melody):
            at=start+2+j*2.4
            if at<start+length-3:
                add(at,3.5,note,.047,'piano',np.sin(j)*.35)
    # Chapter impact, then a rise leading into the next cinematic cut.
    if mode>0:
        add(start,3.4,26,.10 if mode in (3,4,6) else .055,'drum')
    if mode not in (3,7):
        add(start+length-5,4.6,60,.11,'air',.2)
    print('scored',chapter['id'],flush=True)

# Spatial late field: deterministic crossed delay taps, dry signal preserved.
dry = out.copy()
for delay, gain in [(0.113,.18),(.239,.15),(.397,.12),(.617,.10),(.941,.07),(1.337,.05),(1.871,.035)]:
    offset=int(delay*SR)
    out[offset:] += dry[:-offset,::-1]*gain

# Keep the spoken text intelligible; smoothly duck only the music underneath speech.
envelope=np.ones(len(out),dtype=np.float32)
for chapter in chapters:
    for voice in chapter['voices']:
        a=max(0,int((voice['start']-.16)*SR)); b=min(len(out),int((voice['end']+.25)*SR))
        if b<=a:
            continue
        t=np.arange(b-a,dtype=np.float32)/SR
        smooth=np.minimum(1,t/.16)*np.minimum(1,(b-a)/SR-t)
        envelope[a:b]=np.minimum(envelope[a:b],1-.48*np.maximum(0,smooth))
out *= envelope[:,None]
out=np.tanh(out*1.6)/1.6
out*=np.minimum(1,np.arange(len(out))/SR/3)[:,None]
out*=np.minimum(1,(len(out)-np.arange(len(out)))/SR/4)[:,None]
dest=ROOT/'assets/audio/starself-score.wav'
with wave.open(str(dest),'wb') as wav:
    wav.setnchannels(2);wav.setsampwidth(2);wav.setframerate(SR)
    wav.writeframes((np.clip(out,-1,1)*32767).astype('<i2').tobytes())
(ROOT/'score-events.json').write_text(json.dumps({'sampleRate':SR,'seed':817203,'duration':duration,'events':events},ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'seconds':duration,'peak':float(np.max(np.abs(out))),'rms':float(np.sqrt(np.mean(out*out))),'events':len(events),'output':str(dest)}),flush=True)
