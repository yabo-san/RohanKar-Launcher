import json, urllib.request, urllib.parse, sys
UA={'User-Agent':'y4bo-catalog-review'}
def get(u):
    return json.load(urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=60))
h='@chun_s_ready-to-go_recomp_games'
ids=[]
for page in range(1,6):
    u='https://archive.org/services/search/beta/page_production/?'+urllib.parse.urlencode({'page_type':'account_details','page_target':h,'page_elements':'["uploads"]','hits_per_page':200,'page':page})
    try: d=get(u)
    except Exception as e: print('PAGEERR',e); break
    hits=d.get('response',{}).get('body',{}).get('page_elements',{}).get('uploads',{}).get('hits',{}).get('hits',[])
    if page==1: print('RAWKEYS', json.dumps(d)[:1500])
    if not hits: break
    ids += [x['fields']['identifier'] for x in hits]
print('IDS', len(ids))
emails=set()
for i in ids[:3]:
    md=get('https://archive.org/metadata/'+i)['metadata']; emails.add(md.get('uploader'))
print('EMAILS', emails)
out=[]
for i in ids:
    try:
        m=get('https://archive.org/metadata/'+i)
    except Exception as e:
        print('MDERR',i,e); continue
    md=m.get('metadata',{})
    files=[(f['name'],f.get('size')) for f in m.get('files',[]) if f.get('source')=='original' and not f['name'].endswith(('.xml','.sqlite','.torrent'))]
    out.append({'id':i,'title':md.get('title'),'uploader':md.get('uploader'),'mediatype':md.get('mediatype'),'addeddate':md.get('addeddate'),'size':m.get('item_size'),'subject':md.get('subject'),'description':(md.get('description') or '')[:300] if isinstance(md.get('description'),str) else md.get('description'),'files':files[:15],'nfiles':len(files),'dark':m.get('is_dark')})
for e in emails:
    if not e: continue
    q='uploader:%s'%e
    s=get('https://archive.org/advancedsearch.php?'+urllib.parse.urlencode({'q':q,'fl[]':'identifier','rows':1000,'output':'json'}))
    print('SEARCH',q,s['response']['numFound'], sorted(set(d['identifier'] for d in s['response']['docs'])-set(ids)))
    s=get('https://archive.org/advancedsearch.php?'+urllib.parse.urlencode({'q':q+' mediatype:software','fl[]':'identifier','rows':1000,'output':'json'}))
    print('SEARCHSW',s['response']['numFound'])
print('BEGINJSON')
print(json.dumps(out))
print('ENDJSON')
