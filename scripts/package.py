from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import hashlib
root = Path(__file__).resolve().parents[1]
out = root / 'release'
out.mkdir(exist_ok=True)
paths = [root / n for n in ['package.json', 'package-lock.json', 'server.mjs', 'cli.mjs', 'README.md', 'LICENSE', 'Open Downloads Sorter.command', 'Start Downloads Sorter.bat', 'start.sh']]
for folder in ['lib', 'public', 'tests', 'scripts', 'docs']:
    for p in sorted((root / folder).rglob('*')):
        parts = p.relative_to(root).parts
        if p.is_file() and not any(root.joinpath(*parts[:i]).is_symlink() for i in range(1, len(parts) + 1)) and not any(n.startswith('.') or n == '__pycache__' for n in parts):
            paths.append(p)
archive = out / 'downloads-sorter.zip'
with ZipFile(archive, 'w', ZIP_DEFLATED) as z:
    for p in paths:
        if p.is_symlink():
            raise ValueError('Refusing symlink input')
        z.write(p, 'downloads-sorter/' + str(p.relative_to(root)))
with ZipFile(archive) as z:
    assert z.testzip() is None
    assert not any('.local-data' in n or 'node_modules' in n or '/.git/' in n for n in z.namelist())
(out / 'SHA256SUMS.txt').write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + '  downloads-sorter.zip\n')
print(f'{len(paths)} files packaged: {archive.stat().st_size:,} bytes; runtime data excluded.')
