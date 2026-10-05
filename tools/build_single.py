#!/usr/bin/env python3
"""Bundle index.html, css and js into one self-contained HTML file.

  python3 tools/build_single.py dist/시험공부매니저.html            # local file (double-click to open)
  python3 tools/build_single.py out.html --artifact                 # for hosting as a Claude artifact

--artifact writes page content without <html>/<head>/<body> (the host adds them) and removes the
"파일로 저장" backup button, because the artifact viewer blocks file downloads.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def build(artifact):
    html = (ROOT / 'index.html').read_text(encoding='utf-8')
    css = (ROOT / 'css/styles.css').read_text(encoding='utf-8')
    scripts = [(ROOT / src).read_text(encoding='utf-8') for src in re.findall(r'<script src="([^"]+)"', html)]
    if any('</script' in js for js in scripts):
        sys.exit('a script contains "</script" and cannot be inlined')
    body = re.search(r'<body>(.*)</body>', html, re.S).group(1)
    body = re.sub(r'\s*<script src="[^"]+"></script>', '', body).strip()
    inline = ''.join(f'<script>\n{js}\n</script>\n' for js in scripts)

    if not artifact:
        return (
            '<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            f'<title>시험 공부 매니저</title>\n<style>\n{css}\n</style>\n</head>\n<body>\n{body}\n{inline}</body>\n</html>\n'
        )

    page = f'<title>시험 공부 매니저</title>\n<style>\n{css}\n</style>\n{body}\n{inline}'
    for snippet in [
        '        <button data-action="export-file">파일로 저장</button>\n',
        '\n      <p class="small muted">"파일로 저장"은 index.html을 브라우저에서 직접 열었을 때만 동작합니다.</p>',
        "      case 'export-file': exportFile(); break;\n",
    ]:
        if snippet not in page:
            sys.exit(f'expected snippet not found: {snippet.strip()}')
        page = page.replace(snippet, '')
    page, n = re.subn(r"  function exportFile\(\) \{.*?\n  \}\n\n", '', page, flags=re.S)
    if n != 1:
        sys.exit('exportFile() not found')
    return page


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    out = Path(sys.argv[1])
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(build('--artifact' in sys.argv), encoding='utf-8')
    print(f'wrote {out} ({out.stat().st_size // 1024} KB)')
