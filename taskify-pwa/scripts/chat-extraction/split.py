import re, sys, json
src_path, dst_path, wanted_json, dst_header, reexport = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
wanted=set(json.loads(wanted_json))
s=open(src_path).read()
lines=s.split('\n')
# imports block: leading lines until first non-import top-level statement
i=0; imports=[]
while i<len(lines):
    l=lines[i]
    if l.startswith('import ') or (imports and not re.match(r'^(export|const|function|type|let|class|async|//|/\*|\s*$)', l) and not l.startswith('}') is False):
        pass
    if l.startswith('import '):
        # collect until line ending the import
        block=[l]
        while not re.search(r'from\s+["\'][^"\']+["\'];?\s*$', block[-1]) and not re.match(r'^import\s+["\']', block[-1]):
            i+=1; block.append(lines[i])
        imports.append('\n'.join(block)); i+=1; continue
    if l.startswith('// @ts-nocheck') or l.strip()=='' or l.startswith('"use client"'):
        i+=1; continue
    break
body_start=i
# split body into top-level declarations: start at lines beginning at column 0 with a non-space, non-closing char
decls=[]; cur=None; comments=[]
for k in range(body_start,len(lines)):
    l=lines[k]
    starts = re.match(r'^(export |const |function |async function |type |let |class |interface |enum )', l) is not None
    if starts:
        if cur: decls.append(cur)
        cur={'lines':comments+[l]}; comments=[]
    elif re.match(r'^(//|/\*\*|/\*| \*)', l) and (cur is None or cur.get('closed')):
        comments.append(l)
    else:
        if cur is None: comments.append(l)
        else:
            cur['lines'].append(l)
            if l.startswith('}') or l.startswith(');') or l.endswith(';') and not l.startswith(' '):
                cur['closed']=True
if cur: decls.append(cur)
if comments and decls: decls[-1]['lines']+=comments
def strip(t):
    t=re.sub(r'//[^\n]*','',t); t=re.sub(r'/\*.*?\*/','',t,flags=re.S)
    t=re.sub(r'"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'','""',t); return t
for d in decls:
    text='\n'.join(d['lines']); d['text']=text
    head=re.sub(r'^(//.*\n|\s*/\*[\s\S]*?\*/\s*\n)*','',text)
    m=re.match(r'(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|type|let|class|interface|enum)\s+([A-Za-z_]\w*)',head)
    d['name']=m.group(1) if m else None
    d['uses']=set(re.findall(r'(?<![.\w])([A-Za-z_]\w*)',strip(text)))
names={d['name']:d for d in decls if d['name']}
take=set(); work=[w for w in wanted if w in names]
while work:
    n=work.pop()
    if n in take: continue
    take.add(n)
    work+=[u for u in names[n]['uses'] if u in names and u not in take and u!=n]
moved=[d for d in decls if d['name'] in take]
kept=[d for d in decls if d['name'] not in take]
# leftover re-export lines like "export { x as y } from" are in imports? handle 'export {' lines in body
def fix_import_paths(imp, frm, to):
    import os
    def rep(m):
        spec=m.group(2)
        if not spec.startswith('.'): return m.group(0)
        target=os.path.normpath(os.path.join(os.path.dirname(frm), spec))
        r=os.path.relpath(target, os.path.dirname(to))
        if not r.startswith('.'): r='./'+r
        return f'{m.group(1)}{r}{m.group(1)}'
    return re.sub(r'(["\'])([^"\']+)\1', rep, imp)
dst_imports=[fix_import_paths(x, src_path, dst_path) for x in imports]
dst='\n'.join([dst_header]+dst_imports+['']+[d['text'] for d in moved])+'\n'
open(dst_path,'w').write(dst)
# source keeps its imports, kept decls, plus a re-export of moved names and an import for internal use
import os
rel=os.path.relpath(os.path.splitext(dst_path)[0], os.path.dirname(src_path))
if not rel.startswith('.'): rel='./'+rel
used_by_kept=set().union(*[d['uses'] for d in kept]) if kept else set()
internal=sorted(n for n in take if n in used_by_kept)
head_lines=[l for l in lines[:body_start]]
out='\n'.join(head_lines).rstrip('\n')+'\n'
if internal:
    out+=f'import {{ {", ".join(internal)} }} from "{rel}";\n'
out+=f'{reexport}\nexport * from "{rel}";\n\n'+'\n'.join(d['text'] for d in kept)+'\n'
open(src_path,'w').write(out)
print('moved', len(moved), 'kept', len(kept), 'internal imports', internal[:10])
