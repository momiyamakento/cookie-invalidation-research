"""Japanese write-up and explicitly post-hoc window sensitivity, no reruns."""
import csv, hashlib, json, statistics, sys
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

root=Path(sys.argv[1]).resolve()
summary=json.loads((root/'summary.json').read_text(encoding='utf-8'))
verification=json.loads((root/'verification.json').read_text(encoding='utf-8'))
if verification['status']!='passed': raise SystemExit('Independent verification must pass before write-up')
if not (root/'completed.json').exists(): raise SystemExit('Run is not complete')
raw=[json.loads(p.read_text(encoding='utf-8')) for p in sorted(root.glob('b*/trial.json'))]
measured=[t for t in raw if t['phase']=='measurement']
local=summary['arms']['local']; coord=summary['arms']['coordinated']
bounds=[]
for t in measured:
    if t['arm']!='coordinated': continue
    for timing in t['primary']['timings']:
        upper=timing['first401Ms']
        if upper is None: continue
        accepted=[r['start'] for r in t['access'] if r['key']==timing['key'] and r['status']==200 and r['start'] is not None and r['start']<upper]
        lower=max(accepted) if accepted else 0
        bounds.append({'trialId':t['trialId'],'key':timing['key'],'lowerMs':lower,'upperMs':upper,'widthMs':upper-lower})
if bounds:
    with (root/'observation-bounds.csv').open('w',encoding='utf-8-sig',newline='') as out:
        writer=csv.DictWriter(out,fieldnames=list(bounds[0])); writer.writeheader(); writer.writerows(bounds)
def f(v,n=2): return '未到達' if v is None else f'{v:,.{n}f}'
matched=[]
for pair in sorted({(t['block'],t['repetition']) for t in measured}):
    arms={t['arm']:t for t in measured if (t['block'],t['repetition'])==pair}
    maps={arm:{(r['key'],round(r['due'],7)):r for r in t['access'] if not r['source'] and r['role']=='target'} for arm,t in arms.items()}
    common=[key for key,r in maps['local'].items() if r['start'] is not None and maps['coordinated'][key]['start'] is not None]
    a=sum(maps['local'][key]['status']==200 for key in common)
    b=sum(maps['coordinated'][key]['status']==200 for key in common)
    matched.append({'block':pair[0],'repetition':pair[1],'commonSent':len(common),'localAccepted':a,'coordinatedAccepted':b,'difference':a-b})
with (root/'matched-exposure.csv').open('w',encoding='utf-8-sig',newline='') as out:
    writer=csv.DictWriter(out,fieldnames=list(matched[0])); writer.writeheader(); writer.writerows(matched)
unknowns=[{'trialId':t['trialId'],**r} for t in measured for r in t['access'] if r['error'] is not None or r['status'] not in (200,401)]
(root/'exceptions.json').write_text(json.dumps(unknowns,ensure_ascii=False,indent=2),encoding='utf-8')
exception_types={}
for r in unknowns: exception_types[r['error'] or f"HTTP_{r['status']}"]=exception_types.get(r['error'] or f"HTTP_{r['status']}",0)+1
windows=[100,250,500,1000,10000]
windows=[w for w in windows if w<=summary['config']['windowMs']]
window_rows=[]
for w in windows:
    for arm in ['local','coordinated']:
        totals=[]; successes=[]
        for t in measured:
            if t['arm']!=arm: continue
            # Supplemental grouping by planned time retains identical exposure schedules.
            rows=[r for r in t['access'] if not r['source'] and r['role']=='target' and r['due']<w]
            totals.append(len(rows)); successes.append(sum(r['status']==200 for r in rows))
        window_rows.append({'windowMs':w,'arm':arm,'meanPlanned':statistics.mean(totals),'meanAccepted':statistics.mean(successes)})
with (root/'window-sensitivity.csv').open('w',encoding='utf-8-sig',newline='') as out:
    writer=csv.DictWriter(out,fieldnames=list(window_rows[0])); writer.writeheader(); writer.writerows(window_rows)
fig,axes=plt.subplots(1,2,figsize=(10,4),layout='constrained')
for arm,label,color in [('local','Local only','#8b929a'),('coordinated','Coordinated','#007e80')]:
    wr=[r for r in window_rows if r['arm']==arm]
    axes[0].plot([r['windowMs'] for r in wr],[r['meanAccepted'] for r in wr],'o-',label=label,color=color)
    early=[r for r in wr if r['windowMs']<=1000]
    axes[1].plot([r['windowMs'] for r in early],[r['meanAccepted'] for r in early],'o-',label=label,color=color)
for ax in axes:
    ax.set_xlabel('Planned-access window after decoy request (ms)'); ax.set_ylabel('Mean accepted requests, other services'); ax.grid(alpha=.2); ax.legend()
axes[0].set_title('Supplemental: dependence on observation window')
axes[1].set_title('First second: successful accesses remain')
fig.savefig(root/'window-sensitivity.png',dpi=180); fig.savefig(root/'window-sensitivity.svg'); plt.close(fig)
blocks=[]
for b in sorted({t['block'] for t in measured}):
    own=[t for t in measured if t['block']==b and t['arm']=='coordinated']
    den=[t['primary']['allDeniedMs'] for t in own if t['primary']['allDeniedMs'] is not None]
    blocks.append(f"|{b}|{len(own)}|{f(statistics.mean(t['primary']['accepted'] for t in own))}|{f(statistics.mean(den)) if den else '未到達'}|")
rows=[]
for w in windows:
    a=next(r for r in window_rows if r['windowMs']==w and r['arm']=='local')
    b=next(r for r in window_rows if r['windowMs']==w and r['arm']=='coordinated')
    red=100*(a['meanAccepted']-b['meanAccepted'])/a['meanAccepted'] if a['meanAccepted'] else None
    rows.append(f"|{w}|{f(a['meanAccepted'])}|{f(b['meanAccepted'])}|{f(red)}%|")
text=f'''# 囮Cookie検知後の連携失効：比較評価結果

実施・整理日：2026年10月16日。結果ディレクトリ：{root.name}。

## 結論

固定したローカル合成条件では、他9サービスへの認証済みアクセス成功件数は非連携の平均{f(local['accepted']['mean'])}件から連携の平均{f(coord['accepted']['mean'])}件へ減少した。10秒窓での対応試行ごとの削減率平均は{f(summary['pairedReductionPercent']['mean'])}%であった。連携群の全18Cookie拒否観測時間は平均{f(coord['denialMs']['mean'])}ms、p95 {f(coord['denialMs']['p95'])}msだった。

一方、連携群でも一度以上成功したサービス数は平均{f(coord['successfulServices']['mean'])}件であり、非連携の平均{f(local['successfulServices']['mean'])}件と比較して、サービスへの最初の到達を防げたとは限らない。現時点の成果は「検知後の継続的な悪用を止める」ことであり、検知直後から全アクセスを阻止することではない。

この削減率は指定アクセス列と10秒の観測窓に依存する。実攻撃の被害を同率で減らすという意味ではなく、通信エラーを防御成功に数えた値でもない。

## 1. 今回実施したこと

1. 比較計画と指標を文書化し、予備実験後に本条件を固定した。
2. 既存の実際のログイン・囮使用検知・通知・並列失効の経路を接続した評価用コードを追加した。
3. 非連携でも同じ検知元ローカル失効を実行し、他サービスへの通知有無を比較した。
4. 3サービスの動作確認と10サービスの4対応組の予備実験を実施した。
5. 本評価を3ブロックで行い、生HTTP記録・SQLite・管理イベント・ジョブを独立再集計した。
6. 図表と論文用の結果・考察を作成した。

## 2. 実験条件

- 10サービス（実研究アプリの検知元Site B＋既存評価fixture9サービス）。各サービスは別プロセス、同一PCのlocalhostで通信。
- 対象1人・対象外1人、各サービス各人2セッション。対象者のサービス内IDは互いに異なる。
- 検知元の/loginを実行して発行した囮Cookieを実際の検知URLへ提示する。検知通知の直接注入だけの評価ではない。
- 両方式で検知元のローカル失効を同一に実行。連携方式のみ既存通知クライアントと管理サーバーを経由する。
- 主対象は他9サービスの18Cookie、各100ms周期、10秒、1試行1,800予定アクセス。位相は分散させ、両方式で同じ予定列を使う。
- 本測定は各方式30回（30対応組）。別途6試行のウォームアップを保存し集計から除外。
- 管理・Cookie・DBは試行ごとに初期化。方式順を交互化し、予備実験は本測定に混ぜない。
- 起点は囮リクエスト送信開始。拒否観測にはHTTP通信と確認周期の影響が含まれる。サーバー内部の真の失効瞬間ではない。

## 3. 主要結果

|指標|非連携|連携|
|---|---:|---:|
|本測定試行|{local['trials']}|{coord['trials']}|
|他サービスへの成功件数・平均|{f(local['accepted']['mean'])}|{f(coord['accepted']['mean'])}|
|成功件数・中央値|{f(local['accepted']['median'])}|{f(coord['accepted']['median'])}|
|一度以上成功したサービス数・平均|{f(local['successfulServices']['mean'])}|{f(coord['successfulServices']['mean'])}|
|全Cookie拒否観測時間・平均|未到達|{f(coord['denialMs']['mean'])}ms|
|同・p95|未到達|{f(coord['denialMs']['p95'])}ms|
|拒否未到達の試行|{local['notReached']}|{coord['notReached']}|
|主対象の予定要求数|{local['totalPlanned']:,}|{coord['totalPlanned']:,}|
|主対象の送信数|{local['totalSent']:,}|{coord['totalSent']:,}|
|主対象の確認不能|{local['unknown']}|{coord['unknown']}|
|観測中の対象外Cookieの200以外|{local['controlUnknown']}|{coord['controlUnknown']}|
|終了時DB状態一致の試行|{local['dbCorrect']}|{coord['dbCorrect']}|
|終了時HTTP状態一致の試行|{local['finalCorrect']}|{coord['finalCorrect']}|
|401観測後に開始した要求の200|{local['after401Accepted']}|{coord['after401Accepted']}|

![対応試行の比較と拒否観測時間](comparison.png)

非連携は観測窓内に拒否が成立しない打ち切りデータであり、10,000msで完了したとして平均には入れない。各30試行のp95は記述統計であって性能保証や統計的有意差ではない。

### 例外と比較への影響

本測定の全対象・対照を含む確認不能の内訳：{json.dumps(exception_types,ensure_ascii=False)}。WINDOW_EXPIREDは予定要求を実行する時点で窓を越えたため送信しなかった記録であり、アクセス拒否ではない。全行をexceptions.jsonへ保存した。再実行や除外で置き換えていない。

補足として各対応組で両方式とも実際に送信した同じ予定要求へ限定すると、総対応要求数は{sum(p['commonSent'] for p in matched):,}件、非連携の成功{sum(p['localAccepted'] for p in matched):,}件、連携の成功{sum(p['coordinatedAccepted'] for p in matched):,}件だった。これは事後の健全性確認であり主解析の置き換えではない。通信エラーが含まれる場合は、この限定だけで確認不能が解消するわけではない。

## 4. 反復と測定の不確かさ

|ブロック|連携試行数|成功件数平均|拒否観測平均 [ms]|
|---|---:|---:|---:|
{chr(10).join(blocks)}

予定送信時刻からの遅れの試行別p95平均は、非連携{f(local['lagP95Ms']['mean'])}ms、連携{f(coord['lagP95Ms']['mean'])}ms。全要求中の遅れの最大はそれぞれ{f(local['lagMaxMs'])}ms、{f(coord['lagMaxMs'])}msだった。同じ「予定列」を与えたが実送信時刻を完全一致させた実験ではない。計測用HTTPの負荷も含まれる。

Cookie単位の失効時刻を保守的に囲む区間を、最後の成功要求の送信開始から最初の401受信まで（成功要求がなければ起点から）として求めた。区間幅の中央値は{f(statistics.median(b['widthMs'] for b in bounds))}ms、最大は{f(max(b['widthMs'] for b in bounds))}msだった。この観測精度より細かい実失効時刻を測れたとは主張しない。observation-bounds.csvに保存した。

## 5. 補足：観測窓による削減率の違い

以下は本測定後に同じ生データを予定送信時刻で区切った記述的な補足分析である。追加実験でも、事前固定した主指標の置き換えでもない。予定時刻で群を揃えているため、各窓の実時刻以内に完了した件数とは異なる。

|予定アクセス窓 [ms]|非連携の成功平均|連携の成功平均|平均件数からの削減率|
|---|---:|---:|---:|
{chr(10).join(rows)}

![観測窓と初期成功の補足分析](window-sensitivity.png)

長い観測窓ほど非連携の成功が蓄積し、削減率は大きくなる。したがって、卒論では高い割合だけを強調せず、窓の長さ、残った成功件数、拒否到達時間を併記する。

## 6. 結果の解釈と限界

目的への根拠：一つのサービスでの実際の囮使用検知を、他サービスの旧Cookie拒否へ結び付けられた。同一利用者の複数セッションを失効させつつ対象外を維持することを、DBとHTTPの両方で確認した。

制約：検知は実験で確実に発生させた。囮を使う確率、通常利用時の誤検知率、検知前の不正操作量は測っていない。100ms周期のアクセス列と10秒窓は評価条件であり、現実の攻撃速度の推定ではない。サービス数の減少が得られない結果も含め、初期侵入や情報取得を完全に防げるとは言えない。

非連携では他サービスを失効しないため、成功が続くことは設計上予想される。本評価は未知の優位性を発見した比較ではなく、具体的な実装で差が生じることと、残存成功・到達時間・対象分離を定量化したもの。

同一PC、評価用のサービス、通常アクセス負荷なし、研究用セッションであり、異なるホストや実インターネットへの一般化はできない。今回の検知元ローカル失効を追加したadapterは評価コードであり、従来の研究本体をそのまま無変更で動かした比較と混同しない。

## 7. 論文へ記載できる文章案

> 囮Cookie使用検知後の連携失効の効果を評価するため、検知元のみを失効する条件と、他サービスへも失効を連携する条件を比較した。10サービス、各利用者各サービス2セッションのローカル環境において、他9サービスの18Cookieへ同一の予定アクセス列を与え、各条件30回測定した。10秒の観測窓では、認証済みアクセス成功件数は非連携の平均{f(local['accepted']['mean'])}件に対して連携で平均{f(coord['accepted']['mean'])}件であった。連携条件の全対象Cookie拒否観測時間は平均{f(coord['denialMs']['mean'])}msであり、非連携条件は観測窓内に拒否へ到達しなかった。一方、連携条件でも一度以上成功したサービス数は平均{f(coord['successfulServices']['mean'])}件であり、初期アクセスの成功は残った。この結果は、指定した条件下で検知後の継続的な悪用を抑制できることを示すが、実被害の削減率や初期侵入の防止を示すものではない。

## 8. 検証・成果物

独立照合：{verification['verifiedTrials']}試行、整合性エラー{len(verification['errors'])}件。実行時ソースのハッシュ、固定アクセス列、時刻順序、実検知イベント、管理ジョブ、対応付け、ローカル失効件数、終了時DB/HTTP、集計値を照合した。

関連テスト91件、TypeScript型チェック、追加TypeScriptコードのLintは本測定前に通過。過去の研究全体の全テストを今回再実施したという意味ではない。

- summary.json、trials.csv、pairs.csv：独立集計。
- verification.json：照合結果。
- 各試行フォルダ：trial.json、検知元・各サービス・管理DB。
- source-snapshot：実行時コードと設計書。
- COORDINATION-README.md：再実行方法。

既存の4ページ中間報告PDFは更新していない。本結果を反映する際は、本稿の未実施評価という記述と、原稿の字数・図表を更新する。
'''
(root/'REPORT.md').write_text(text,encoding='utf-8')
(root/'report-generation.json').write_text(json.dumps({'writeupSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
 'note':'Supplementary observation-window analysis added after main protocol was frozen; no experiments rerun.'},indent=2),encoding='utf-8')
print(root/'REPORT.md')
