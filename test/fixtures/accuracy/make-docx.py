# python test/fixtures/accuracy/make-docx.py  -> history-chapter.docx from corpus.json, one explicit page break per page
import json, pathlib, docx

here = pathlib.Path(__file__).parent
spec = next(f for f in json.loads((here / 'corpus.json').read_text(encoding='utf-8'))['files'] if f['make'] == 'docx')
d = docx.Document()
for i, page in enumerate(spec['pages']):
    if i:
        d.add_page_break()
    d.add_heading(page['heading'], level=1)
    for p in page['paras']:
        d.add_paragraph(p)
d.save(here / spec['name'])
print(here / spec['name'])
