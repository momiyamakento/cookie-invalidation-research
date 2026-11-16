import json, os, sys
import matplotlib.pyplot as plt
d = sys.argv[1]
with open(os.path.join(d, 'summary.json'), encoding='utf8') as f: rows=json.load(f)['conditions']
os.makedirs(os.path.join(d,'graphs'),exist_ok=True)
x=[r['serviceCount'] for r in rows]
def draw(name,title,ylabel,keys,labels,scale=1):
 plt.figure(figsize=(8,5),dpi=180)
 for key,label in zip(keys,labels):
  y=[r[key]['meanMs']/scale for r in rows]; e=[r[key]['populationStandardDeviationMs']/scale for r in rows]
  plt.errorbar(x,y,yerr=e,marker='o',capsize=3,label=label)
 plt.xticks(x, [str(value) for value in x]); plt.xlabel('Number of logged-in web services (services)'); plt.ylabel(ylabel); plt.title(title); plt.grid(True,alpha=.3); plt.legend(); plt.tight_layout(); plt.savefig(os.path.join(d,'graphs',name),dpi=300); plt.close()
draw('invalidation-time.png','Service count vs invalidation completion time','Mean completion time (ms)',['invalidationCompletionTimeMs'],['mean ± population SD'])
draw('cpu-load.png','Service count vs Management Server CPU time','CPU time during invalidation (ms)',['cpuUserMs','cpuSystemMs'],['user','system'])
draw('memory.png','Service count vs Management Server memory','Memory after invalidation (MB)',['rssAfterBytes','heapUsedAfterBytes'],['RSS','heap used'],1024*1024)
draw('pre-invalidation-memory.png','Logged-in services vs pre-invalidation memory','Memory before invalidation (MB)',['rssBeforeBytes','heapUsedBeforeBytes'],['RSS','heap used'],1024*1024)
