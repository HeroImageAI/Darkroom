import json,sys,glob,os
def dump(nodes, links_idx, ind=""):
    for n in sorted(nodes, key=lambda n: n.get("order",0)):
        t=n.get("type"); 
        if t in ("Note","MarkdownNote"): 
            txt=(n.get("widgets_values") or [""])[0]; print(ind+"NOTE:", str(txt)[:1200].replace("\n"," | ")); continue
        ins=[f"{i['name']}<-{links_idx.get(i.get('link'),'?')}" for i in n.get("inputs",[]) if i.get("link") is not None]
        print(f"{ind}[{n['id']}] {t} {('«'+n['title']+'»') if n.get('title') else ''} W={n.get('widgets_values')} IN={ins} mode={n.get('mode',0)}")
def links_map(links):
    m={}
    for l in links or []:
        if isinstance(l,list): m[l[0]]=f"{l[1]}.{l[2]}"
        else: m[l['id']]=f"{l['origin_id']}.{l['origin_slot']}"
    return m
for p in sys.argv[1:]:
    d=json.load(open(p,encoding="utf-8"))
    print("=================", os.path.basename(p))
    dump(d.get("nodes",[]), links_map(d.get("links")))
    for sg in (d.get("definitions") or {}).get("subgraphs",[]):
        print("  --- subgraph", sg.get("name"), sg.get("id"))
        dump(sg.get("nodes",[]), links_map(sg.get("links")), "    ")
    for m in d.get("models",[]) or []: print("  MODEL", m)
