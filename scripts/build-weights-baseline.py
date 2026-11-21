"""打包基线权重：只带生效模型 + 精简 registry，供 GitHub Release 分发。"""
import hashlib
import json
import zipfile
from pathlib import Path

ROOT = Path('C:/Users/毛守坤/Desktop/Handwritten-Digit-Recognition')
weights = ROOT / 'model-service' / 'weights'
registry = json.loads((weights / 'registry.json').read_text(encoding='utf-8'))
models = registry['models']

target_version = 'w4-task-8-a1'
entry = next((m for m in models if m.get('version') == target_version), None)
if entry is None:
    raise SystemExit(f'registry 里没有 {target_version}')

artifact = entry['artifact']
source = weights / artifact
if not source.is_file():
    raise SystemExit(f'权重文件不存在: {source}')

digest = hashlib.sha256(source.read_bytes()).hexdigest()
print('生效模型:', entry['modelId'], entry['version'], '| 文件', artifact, '|', len(source.read_bytes()), 'bytes')
print('sha256 一致:', digest == entry.get('sha256'))

out_dir = ROOT / 'dist'
out_dir.mkdir(exist_ok=True)
zip_path = out_dir / 'hdr-weights-baseline-v1.zip'

slim_registry = {'models': [entry]}
manifest = {
    'name': 'hdr-weights-baseline',
    'version': 'v1',
    'generatedAt': '2026-11-19',
    'activeModel': {'modelId': entry['modelId'], 'version': entry['version']},
    'files': [{'path': artifact, 'sha256': entry['sha256'], 'sizeBytes': entry['sizeBytes']}],
}

with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.writestr('registry.json', json.dumps(slim_registry, ensure_ascii=False, indent=2))
    archive.writestr('MANIFEST.json', json.dumps(manifest, ensure_ascii=False, indent=2))
    archive.write(source, artifact)

print('已生成', zip_path, '|', round(zip_path.stat().st_size / 1024 / 1024, 2), 'MB')
