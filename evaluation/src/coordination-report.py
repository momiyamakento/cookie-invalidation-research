"""Independent reconstruction from HTTP rows and saved SQLite, not runner summaries."""
import csv, hashlib, json, math, sqlite3, statistics, sys
from pathlib import Path
from collections import defaultdict

root = Path(sys.argv[1]).resolve()
manifest = json.loads((root/'manifest.json').read_text(encoding='utf-8'))
cfg = manifest['config']
errors=[]
def require(ok, message):
    if not ok: errors.append(message)
def stats(values):
    v=sorted(x for x in values if x is not None)
    return {'n':len(v),'mean':statistics.mean(v) if v else None,'median':statistics.median(v) if v else None,
            'p95':v[math.ceil(.95*len(v))-1] if v else None,'min':min(v) if v else None,'max':max(v) if v else None}
def sql(path, query):
    with sqlite3.connect(f'{path.as_uri()}?mode=ro',uri=True) as db:
        db.row_factory=sqlite3.Row
        return [dict(r) for r in db.execute(query)]
for name,h in manifest['hashes'].items():
    p=root/'source-snapshot'/f'{name}.txt'
    require(hashlib.sha256(p.read_bytes()).hexdigest()==h,f'snapshot mismatch {name}')
trials=[]
for path in sorted(root.glob('b*/trial.json')):
    t=json.loads(path.read_text(encoding='utf-8')); tid=t['trialId']; win=t['config']['windowMs']
    sessions={s['key']:s for s in t['sessions']}; rows=t['access']
    require(all('cookie' not in s for s in sessions.values()),f'{tid} raw cookie saved')
    selected=[s for s in sessions.values() if s['role']=='target' or s['key'].endswith('-0')]
    expected=[]
    for role,period in [('target',cfg['intervalMs']),('control',1000)]:
        group=[s for s in selected if s['role']==role]
        for i,s in enumerate(group):
            n=0
            while i*period/len(group)+n*period < win:
                expected.append((s['key'],i*period/len(group)+n*period)); n+=1
    actual=sorted((r['key'],r['due']) for r in rows)
    require(len(expected)==len(actual) and all(a[0]==b[0] and abs(a[1]-b[1])<1e-7 for a,b in zip(sorted(expected),actual)),f'{tid} schedule mismatch')
    for r in rows:
        require(r['key'] in sessions,f'{tid} unknown key')
        if r['start'] is not None:
            require(r['start']>=r['due'] and r['start']<win and r['end']>=r['start'],f'{tid} invalid clock/order')
        else: require(r['status']==0 and r['error'] is not None,f'{tid} missing not recorded')
    primary=[r for r in rows if not r['source'] and r['role']=='target']
    keys=[s['key'] for s in sessions.values() if not s['source'] and s['role']=='target']
    first=[]; reversals=0
    for key in keys:
        own=[r for r in primary if r['key']==key]
        times=[r['end'] for r in own if r['status']==401 and r['end'] is not None and r['end']<=win]
        f=min(times) if times else None; first.append(f)
        if f is not None: reversals+=sum(r['status']==200 and r['start'] is not None and r['start']>f for r in own)
    denial=max(first) if all(v is not None for v in first) else None
    accepted=sum(r['status']==200 for r in primary)
    unknown=sum(r['status'] not in [200,401] for r in primary)
    success_services=len({r['serviceId'] for r in primary if r['status']==200})
    require(t['primary']['accepted']==accepted and t['primary']['unknown']==unknown and t['primary']['allDeniedMs']==denial and t['primary']['successfulServices']==success_services,f'{tid} summary mismatch')
    source_events=sql(path.parent/'source.sqlite','SELECT * FROM local_detection_events')
    source_requests=sql(path.parent/'source.sqlite','SELECT * FROM invalidation_requests')
    require(len(source_events)==1,f'{tid} detector event count')
    event_id=source_events[0]['event_id'] if source_events else None
    require(t['detection']['status']==200 and t['detection']['body']['eventId']==event_id and t['detection']['body']['detected'] is True,f'{tid} detector HTTP/event mismatch')
    require(t['negatives'][0]['status']==400 and t['negatives'][1]['status']==404 and all(r['status']==200 for r in t['preflight']),f'{tid} negative control/preflight')
    manager_events=sql(path.parent/'manager.sqlite','SELECT * FROM detection_events')
    jobs=sql(path.parent/'manager.sqlite','SELECT * FROM invalidation_jobs')
    mapping=sql(path.parent/'manager.sqlite','SELECT * FROM user_service_mappings')
    require(len(mapping)==cfg['serviceCount']*2,f'{tid} mapping count')
    if t['arm']=='coordinated':
        require(len(manager_events)==1 and manager_events[0]['event_id']==event_id and manager_events[0]['status']=='SUCCESS',f'{tid} manager event')
        require(len(jobs)==cfg['serviceCount'] and all(j['status']=='SUCCESS' and j['event_id']==event_id and j['revoked_count']==(0 if j['target_service_id']=='site-b' else 2) for j in jobs),f'{tid} jobs mismatch')
    else: require(len(manager_events)==len(jobs)==0,f'{tid} baseline unexpectedly notified')
    require(len(source_requests)==(2 if t['arm']=='coordinated' else 1) and sum(r['revoked_count'] for r in source_requests)==2,f'{tid} local revocation mismatch')
    db_ok=True
    for dbpath in path.parent.glob('*.sqlite'):
        if dbpath.name=='manager.sqlite': continue
        state=sql(dbpath,'SELECT id,user_id,status FROM sessions')
        is_source=dbpath.name=='source.sqlite'
        require(len(state)==4,f'{tid} unexpected session population')
        for s in state:
            target=s['user_id']=='source-target' if is_source else s['user_id'].endswith('-7')
            should_revoke=target and (is_source or t['arm']=='coordinated')
            db_ok &= s['status']==('REVOKED' if should_revoke else 'ACTIVE')
    final_ok=all(r['status']==(401 if r['role']=='target' and (r['source'] or t['arm']=='coordinated') else 200) for r in t['final'])
    require(db_ok==t['dbCorrect'] and final_ok==t['finalCorrect'],f'{tid} state classification mismatch')
    control=[r for r in rows if r['role']=='control']
    lag=[r['start']-r['due'] for r in rows if r['start'] is not None]
    trials.append({'trialId':tid,'phase':t['phase'],'block':t['block'],'repetition':t['repetition'],'arm':t['arm'],
      'planned':len(primary),'sent':sum(r['start'] is not None for r in primary),'accepted':accepted,'denied':sum(r['status']==401 for r in primary),
      'unknown':unknown,'successfulServices':success_services,'allDeniedMs':denial,'after401Accepted':reversals,
      'controlUnknown':sum(r['status']!=200 for r in control),'dbCorrect':db_ok,'finalCorrect':final_ok,
      'detectionResponseMs':t['detection']['end'],'sourceDeniedMs':t['sourceSummary']['allDeniedMs'],
      'lagMeanMs':statistics.mean(lag),'lagP95Ms':stats(lag)['p95'],'lagMaxMs':max(lag),'maxPending':t['maxPending'],'planHash':t['planHash']})
for pair in {(t['block'],t['repetition']) for t in trials}:
    own=[t for t in trials if (t['block'],t['repetition'])==pair]
    require(len(own)==2 and len({t['planHash'] for t in own})==1,f'pair {pair} missing or schedule differs')
measured=[t for t in trials if t['phase']=='measurement']
pairs=[]
for pair in sorted({(t['block'],t['repetition']) for t in measured}):
    own={t['arm']:t for t in measured if (t['block'],t['repetition'])==pair}
    if len(own)!=2: continue
    a,b=own['local'],own['coordinated']
    pairs.append({'block':pair[0],'repetition':pair[1],'baselineAccepted':a['accepted'],'coordinatedAccepted':b['accepted'],
      'difference':a['accepted']-b['accepted'],'reductionPercent':100*(a['accepted']-b['accepted'])/a['accepted'] if a['accepted'] else None})
summary={'config':cfg,'totalTrials':len(trials),'measurementTrials':len(measured),'pairs':len(pairs),
 'verificationErrors':errors,'arms':{},'pairedReductionPercent':stats([p['reductionPercent'] for p in pairs]),
 'pairedDifference':stats([p['difference'] for p in pairs])}
for arm in ['local','coordinated']:
    own=[t for t in measured if t['arm']==arm]
    summary['arms'][arm]={'trials':len(own),'accepted':stats([t['accepted'] for t in own]),'successfulServices':stats([t['successfulServices'] for t in own]),
      'denialMs':stats([t['allDeniedMs'] for t in own]),'notReached':sum(t['allDeniedMs'] is None for t in own),
      'unknown':sum(t['unknown'] for t in own),'controlUnknown':sum(t['controlUnknown'] for t in own),'after401Accepted':sum(t['after401Accepted'] for t in own),
      'dbCorrect':sum(t['dbCorrect'] for t in own),'finalCorrect':sum(t['finalCorrect'] for t in own),
      'lagP95Ms':stats([t['lagP95Ms'] for t in own]),'lagMaxMs':max((t['lagMaxMs'] for t in own),default=None),
      'totalPlanned':sum(t['planned'] for t in own),'totalSent':sum(t['sent'] for t in own)}
for name,data in [('trials',trials),('pairs',pairs)]:
    if data:
        with (root/f'{name}.csv').open('w',encoding='utf-8-sig',newline='') as f:
            w=csv.DictWriter(f,fieldnames=list(data[0])); w.writeheader(); w.writerows(data)
(root/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
(root/'verification.json').write_text(json.dumps({'errors':errors,'verifiedTrials':len(trials),'status':'passed' if not errors else 'failed'},indent=2),encoding='utf-8')
if measured:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    fig,axes=plt.subplots(1,2,figsize=(10,4),layout='constrained')
    for p in pairs: axes[0].plot([0,1],[p['baselineAccepted'],p['coordinatedAccepted']],color='#6786ad',alpha=.35)
    axes[0].set_xticks([0,1],['Local only','Coordinated']); axes[0].set_ylabel('Accepted requests to other services / trial'); axes[0].set_title('Paired fixed-schedule comparison')
    values=[t['allDeniedMs'] for t in measured if t['arm']=='coordinated' and t['allDeniedMs'] is not None]
    axes[1].plot(range(1,len(values)+1),values,'o-',color='#196f75'); axes[1].set_xlabel('Coordinated measurement trial'); axes[1].set_ylabel('All target cookies rejected (observed ms)'); axes[1].set_title('Local-only: censored at window end')
    for ax in axes: ax.grid(axis='y',alpha=.2)
    fig.savefig(root/'comparison.png',dpi=180); fig.savefig(root/'comparison.svg'); plt.close(fig)
print(json.dumps(summary,ensure_ascii=False,indent=2))
if errors: sys.exit(1)
