"""Summarize diagnostics without removing any measured trials."""
import json,sys,statistics as st,csv
from pathlib import Path

root=Path(sys.argv[1]); summaries=[]; detail=[]
mean=lambda xs:st.mean(xs) if xs else 0
mib=lambda n:n/1048576
for file in sorted(root.glob('*/diagnostic.json')):
 d=json.loads(file.read_text()); rows=[r for r in d['records'] if not r['warmup']]
 agg=[]
 for r in rows:
  m=r['managerAfter']; b=r['managerBefore']; q=m['requests']; incoming=m['incoming']; start=incoming[0]['start']; end=incoming[0]['finish']
  events=[e for e in m['gc'] if e['start']<end and e['start']+e['duration']>start]
  sends=[e['start'] for e in q]; bodies=[e['body'] for e in q if e['body'] is not None]
  finish=max(bodies); first=min(sends); last=max(sends)
  cpua=r['hostBefore']['cpu']; cpub=r['hostAfter']['cpu']; total=sum(sum(c.values()) for c in cpub)-sum(sum(c.values()) for c in cpua); idle=sum(c['idle'] for c in cpub)-sum(c['idle'] for c in cpua)
  x={'condition':file.parent.name,'trial':r['trial'],'elapsed':r['elapsed'],'managerRouteMs':end-start,'beforeFetchMs':first-start,'launchSpreadMs':last-first,'allFetchesCompleteMs':finish-first,'afterFetchMs':end-finish,'gcMs':sum(e['duration'] for e in events),'gcCount':len(events),'majorGcCount':sum(e['kind']==4 for e in events),'loopMaxMs':m['loop']['maxMs'],'managerCpuMs':(m['cpu']['user']+m['cpu']['system']-b['cpu']['user']-b['cpu']['system'])/1000,'runnerCpuMs':(r['runnerAfter']['cpu']['user']+r['runnerAfter']['cpu']['system']-r['runnerBefore']['cpu']['user']-r['runnerBefore']['cpu']['system'])/1000,'serviceWorkSumMs':sum(t['actualWorkMs'] for t in r['timings']),'rssBeforeMiB':mib(r['before']['rssBytes']),'rssAfterMiB':mib(r['after']['rssBytes']),'heapAfterMiB':mib(r['after']['heapUsedBytes']),'runnerRssMiB':mib(r['runnerAfter']['memory']['rss']),'hostBusyPercent':100*(1-idle/total) if total else None}
  agg.append(x);detail.append(x)
 summary={'condition':file.parent.name,'profile':d['profile'],'count':d['count'],'mode':d['mode'],'n':len(rows),'meanMs':mean([r['elapsed'] for r in rows]),'medianMs':st.median(r['elapsed'] for r in rows),'maxMs':max(r['elapsed'] for r in rows),'managerGcCount':sum(r['gcCount'] for r in agg),'majorGcCount':sum(r['majorGcCount'] for r in agg)}
 for k in ['gcMs','beforeFetchMs','launchSpreadMs','allFetchesCompleteMs','afterFetchMs','loopMaxMs','managerCpuMs','runnerCpuMs','serviceWorkSumMs','rssBeforeMiB','rssAfterMiB','heapAfterMiB','runnerRssMiB']:summary[k]=mean([r[k] for r in agg])
 for when in ['setupBefore','setupAfter','immediate','idle','collected']:
  for proc in ['manager','runner']:
   for mem in ['rss','heapUsed','heapTotal','external']:
    summary[f'{when}_{proc}_{mem}MiB']=mib(d[when][proc]['memory'][mem])
 summaries.append(summary)
for name,rows in [('summary',summaries),('trials',detail)]:
 (root/(name+'.json')).write_text(json.dumps(rows,indent=2))
 if rows:
  with (root/(name+'.csv')).open('w',newline='') as f:w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)
for s in summaries: print(s['condition'],'time',round(s['meanMs'],1),'rss',round(s['rssAfterMiB'],1),'GC',s['managerGcCount'],'major',s['majorGcCount'],'heap',round(s['heapAfterMiB'],1),'postGC',round(s['collected_manager_heapUsedMiB'],1),'idleRSS',round(s['idle_manager_rssMiB'],1))
print('SLOWEST')
for r in sorted(detail,key=lambda r:r['elapsed'],reverse=True)[:12]:print({k:round(v,2) if isinstance(v,float) else v for k,v in r.items() if k in ['condition','trial','elapsed','gcMs','loopMaxMs','managerCpuMs','beforeFetchMs','launchSpreadMs','allFetchesCompleteMs','afterFetchMs','serviceWorkSumMs','hostBusyPercent']})
