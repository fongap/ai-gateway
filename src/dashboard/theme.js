// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Quiet Technical Interface — design tokens and full CSS for the public
// homepage.  Extracted from pages.js to keep the page renderer focused on
// data flow and HTML structure.  All styling is inlined via a template
// literal so the worker remains zero-dependency (no external fonts, no
// framework, no chart library).

export const THEME_CSS = `
:root{
  --paper:#f8f7f3;
  --paper-2:#f2f0ea;
  --surface:#fff;
  --surface-soft:#f4f3ee;
  --line:#e4e1d8;
  --line-soft:#eceae2;
  --ink:#1b1e1c;
  --ink-2:#565b54;
  --ink-3:#8b8f84;
  --teal:#0f5d53;
  --teal-deep:#0a413a;
  --teal-soft:#e4efec;
  --teal-1:#dce9e3;
  --teal-2:#a9d0c4;
  --teal-3:#7cb4a5;
  --teal-4:#3f8b7c;
  --amber:#b4793b;
  --red:#a75b58;
  --radius:14px;
  --content:65rem;
}
*{
box-sizing:border-box;margin:0;padding:0
}
html{
scroll-behavior:smooth;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility
}
body{
margin:0;
background:radial-gradient(circle at 50% -16%,rgba(15,93,83,.055),transparent 30%),var(--paper);
color:var(--ink);
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
line-height:1.65
}
::selection{background:var(--teal-soft);color:var(--teal-deep)}
a{color:inherit;text-decoration:none}
button{font:inherit}
.wrap{width:min(var(--content),calc(100% - 80px));margin:0 auto}
.sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}

/* header */
header{padding:26px 0 0}
.header-row{display:flex;align-items:center;justify-content:space-between;gap:20px}
.brand{display:flex;align-items:center;gap:11px}
.brand-mark{width:26px;height:26px;display:grid;place-items:center;color:var(--teal);font:500 17px/1 ui-monospace,SFMono-Regular,Consolas,monospace}
.brand-name{font-size:15px;font-weight:600;letter-spacing:.005em}
.github{width:38px;height:38px;display:grid;place-items:center;border-radius:10px;color:var(--ink-3);transition:color .16s ease}
.github:hover{color:var(--ink)}
.github:focus-visible{outline:2px solid var(--teal);outline-offset:3px}

/* hero */
.hero{padding:40px 0 28px;text-align:center}
.hero h1{margin:0 0 12px;font-family:"Songti SC","STSong","SimSun","Noto Serif CJK SC",serif;font-weight:500;font-size:clamp(28px,4vw,42px);line-height:1.28;letter-spacing:-.018em}
.hero p{max-width:680px;margin:0 auto;color:var(--ink-2);font-size:15px;line-height:1.7}

/* sections */
section{padding:32px 0;border-top:1px solid var(--line)}
.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:20px;margin-bottom:24px}
.section-title{font-size:14px;font-weight:600;letter-spacing:.015em}
.section-sub{margin-left:auto;color:var(--ink-3);font-size:12px;white-space:nowrap}

/* model status */
.status-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 56px}
.status-block+.status-block{border-left:1px solid var(--line-soft);padding-left:56px}
.status-group-title{margin-bottom:10px;color:var(--ink-3);font-size:12px}
.status-grid-split{display:grid;grid-template-columns:1fr 1fr;gap:0 32px}
.status-grid-inner{display:grid;grid-template-columns:1fr;gap:0}
.model-row{display:grid;grid-template-columns:minmax(80px,1fr) auto minmax(56px,auto) auto minmax(56px,auto) minmax(80px,1fr) auto minmax(56px,auto);column-gap:14px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line-soft);font-size:12px;white-space:nowrap}
.model-row:last-child{border-bottom:0}
.mr-name{color:var(--ink);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:12.5px;text-align:left;overflow:hidden;text-overflow:ellipsis}
.mr-p50-label,.mr-p95-label{color:var(--ink-3);text-align:left;font-size:12px}
.mr-p50-val,.mr-p95-val{color:var(--ink-2);font-weight:500;font-variant-numeric:tabular-nums;text-align:right;font-size:12px}
.mr-samples{color:var(--ink-3);text-align:right;font-size:12px;overflow:hidden;text-overflow:ellipsis}
.mr-dot{width:6px;height:6px;border-radius:50%;background:var(--teal-4);box-shadow:0 0 0 3px var(--teal-soft);justify-self:start}
.mr-dot.warn{background:var(--amber);box-shadow:0 0 0 3px #f3e8d9}
.mr-dot.down{background:var(--red);box-shadow:0 0 0 3px #f1e1df}
.mr-status{color:var(--ink-2);font-size:12px;text-align:right}

/* stats */
.stat-row{display:grid;grid-template-columns:repeat(4,1fr);margin-bottom:48px}
.stat{padding-right:24px}
.stat+.stat{border-left:1px solid var(--line-soft);padding-left:24px}
.stat-value{font-family:"Songti SC","STSong","SimSun","Noto Serif CJK SC",serif;font-weight:500;font-size:clamp(28px,3.2vw,34px);line-height:1.25;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.stat-label{margin-top:6px;color:var(--ink-3);font-size:12.5px}

/* heatmap */
.subhead{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:18px}
.subhead b{color:var(--ink-2);font-size:13px;font-weight:500}
.subhead span{color:var(--ink-3);font-size:12px}
.heatmap-wrap{overflow-x:auto;padding-bottom:4px;margin-bottom:48px}
.heatmap{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,10px);gap:3px;min-width:760px}
.cell{width:10px;height:10px;border-radius:2px;background:var(--line-soft);outline:none}
.cell[data-level="1"]{background:var(--teal-1)}
.cell[data-level="2"]{background:var(--teal-2)}
.cell[data-level="3"]{background:var(--teal-3)}
.cell[data-level="4"]{background:var(--teal-4)}
.cell:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.months{display:flex;justify-content:space-between;min-width:760px;margin-top:10px;color:var(--ink-3);font-size:10.5px}

/* usage split */
.usage-split{display:grid;grid-template-columns:180px 1fr;gap:58px;align-items:center}
.donut{position:relative;width:156px;height:156px;margin:auto}
.donut svg{display:block;width:100%;height:100%}
.donut-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none}
.donut-center strong{font-family:"Songti SC","STSong","SimSun","Noto Serif CJK SC",serif;font-size:21px;font-weight:500;letter-spacing:-.02em}
.donut-center span{margin-top:3px;color:var(--ink-3);font-size:11px}
.bars{display:flex;flex-direction:column;gap:16px}
.bar-row{display:grid;grid-template-columns:148px 1fr 74px;gap:16px;align-items:center}
.bar-name{display:flex;align-items:center;gap:9px;min-width:0;color:var(--ink-2);font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
.bar-name i{flex:none;width:7px;height:7px;border-radius:50%;background:var(--c)}
.bar-track{height:5px;background:var(--line-soft);border-radius:99px;overflow:hidden}
.bar-track i{display:block;width:var(--w);height:100%;border-radius:99px;background:var(--c)}
.bar-value{text-align:right;color:var(--ink-3);font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-variant-numeric:tabular-nums}
.model-usage-empty{padding:26px 0 20px;text-align:center;font-size:12.5px;color:var(--ink-3)}

/* quick start */
.tabs{display:flex;gap:28px;margin-bottom:24px;border-bottom:1px solid var(--line)}
.tab{position:relative;padding:0 0 14px;border:0;background:none;color:var(--ink-3);cursor:pointer;font-size:13px}
.tab.active{color:var(--ink)}
.tab.active::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;background:var(--teal)}
.tab:focus-visible{outline:2px solid var(--teal);outline-offset:3px}
.code-card{position:relative;padding:25px 27px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);box-shadow:0 1px 2px rgba(20,20,15,.025),0 12px 28px -22px rgba(20,20,15,.2)}
.code-line{overflow-x:auto;white-space:pre;color:var(--ink-2);font-size:13px;line-height:1.8;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
.code-line+.code-line{margin-top:6px}
.code-key{color:var(--ink-3)}
.code-value{color:var(--teal-deep)}
.copy{position:absolute;top:20px;right:22px;border:0;border-radius:8px;padding:7px 13px;background:var(--teal-soft);color:var(--teal-deep);cursor:pointer;font-size:12px}
.copy:hover{background:#d7e8e2}
.copy:focus-visible{outline:2px solid var(--teal);outline-offset:2px}

/* tooltip */
.tooltip{position:fixed;pointer-events:none;z-index:1000;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12px;color:var(--ink);box-shadow:0 2px 6px rgba(27,30,28,.08);white-space:pre-wrap;width:max-content;max-width:90vw;opacity:0;transition:opacity 120ms ease}
.tooltip.show{opacity:1}

/* footer */
footer{padding:32px 0 42px;border-top:1px solid var(--line);color:var(--ink-3);font-size:12px}
.footer-row{display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap}
.footer-sep{color:#b8bbb4}

/* responsive */
@media(max-width:760px){
  .wrap{width:calc(100% - 40px)}
  header{padding-top:22px}
  .hero{padding:32px 0 22px}
  .hero h1{font-size:28px}
  .hero p{font-size:14px}
  section{padding:28px 0}
  .status-grid{grid-template-columns:1fr;gap:34px 0}
  .status-grid-split{grid-template-columns:1fr;gap:34px 0}
  .status-block+.status-block{border-left:0;border-top:1px solid var(--line-soft);padding-left:0;padding-top:30px}
  .model-row{grid-template-columns:1fr;gap:9px}
  .model-meta{grid-template-columns:78px 78px 90px;column-gap:10px}
  .stat-row{grid-template-columns:1fr 1fr;row-gap:30px;margin-bottom:44px}
  .stat:nth-child(3){border-left:0;padding-left:0}
  .usage-split{grid-template-columns:1fr;gap:36px}
  .bar-row{grid-template-columns:110px 1fr 60px;gap:10px}
  .code-card{padding:22px 20px}
  .copy{position:static;margin-top:16px}
}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important}}
@media(forced-colors:active){.cell{border:1px solid CanvasText}}
`;
