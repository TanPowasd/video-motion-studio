"""External authoring, not a model call inside Vmotion. Cache narration by text hash."""
import asyncio
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / '.vmotion/python'))
import edge_tts

VOICES = {'me': 'zh-CN-YunxiNeural', 'you': 'zh-CN-XiaoxiaoNeural'}

async def main():
    story = json.loads((ROOT / 'story.json').read_text(encoding='utf-8'))
    cache = ROOT / '.vmotion/speech'
    cache.mkdir(parents=True, exist_ok=True)
    for chapter in story:
        for i, line in enumerate(chapter['lines']):
            key = hashlib.sha256((line['voice'] + line['text'] + 'v1').encode()).hexdigest()[:10]
            filename = f"{chapter['id']}-{i:02}-{key}.mp3"
            dest = cache / filename
            line['speech'] = filename
            if not dest.exists():
                for attempt in range(3):
                    try:
                        await edge_tts.Communicate(line['text'], VOICES[line['voice']], rate='-8%', pitch='-3Hz' if line['voice'] == 'me' else '-1Hz').save(str(dest) + '.partial')
                        Path(str(dest) + '.partial').replace(dest)
                        break
                    except Exception:
                        if attempt == 2:
                            raise
                        await asyncio.sleep(1)
            print(filename, flush=True)
    (ROOT / '.vmotion/narration.json').write_text(json.dumps(story, ensure_ascii=False, indent=2), encoding='utf-8')

asyncio.run(main())
