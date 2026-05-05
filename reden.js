<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>REDEN — Decision Engine</title>

<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono&family=Inter&family=Syne:wght@700&display=swap" rel="stylesheet"/>

<style>
:root{
--bg:#080b10;
--panel:rgba(255,255,255,0.03);
--border:rgba(255,255,255,0.08);
--accent:#6c8dff;
--green:#34d39a;
--warn:#f5a623;
--red:#ff4d6a;
--t1:#f0f4ff;
--t2:#8a9bb8;
--mono:'IBM Plex Mono',monospace;
--ui:'Inter',sans-serif;
--display:'Syne',sans-serif;
}

*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--t2);font-family:var(--ui)}

.shell{max-width:1200px;margin:auto;padding:24px}
.grid{display:grid;grid-template-columns:320px 1fr 280px;gap:14px}

.panel{
background:var(--panel);
border:1px solid var(--border);
padding:16px;
}

.p-head{
font-family:var(--mono);
font-size:10px;
letter-spacing:2px;
margin-bottom:12px;
color:var(--t2);
}

/* buttons */
.btn{
font-family:var(--mono);
font-size:10px;
padding:8px 12px;
border:1px solid var(--border);
background:none;
cursor:pointer;
}
.btn:hover{border-color:var(--accent);color:var(--t1)}
.btn:disabled{opacity:.3}

/* chip */
.chip{
display:inline-block;
padding:5px 10px;
border:1px solid var(--border);
font-family:var(--mono);
font-size:11px;
}
.explore{
margin-left:6px;
border-color:var(--warn);
color:var(--warn);
font-size:9px;
padding:2px 6px;
}

/* metrics */
.metric{margin-bottom:10px}
.metric .num{font-size:26px;color:var(--t1);font-family:var(--display)}
.metric .lbl{font-size:9px;font-family:var(--mono)}

/* bars */
.bar{
height:4px;
background:rgba(255,255,255,0.08);
position:relative;
margin-top:4px;
}
.fill{
position:absolute;height:100%;
background:var(--accent);
}

/* log */
#log{max-height:200px;overflow:auto;font-family:var(--mono);font-size:10px}
.log{border-bottom:1px solid rgba(255,255,255,.05);padding:4px 0}
.ok{color:var(--green)}
.err{color:var(--red)}
.warn{color:var(--warn)}
</style>
</head>

<body>
<div class="shell">

<header style="display:flex;justify-content:space-between;margin-bottom:20px">
<div>
<div style="font-family:var(--display);font-size:20px;color:var(--t1)">REDEN</div>
<div style="font-family:var(--mono);font-size:9px">DECISION ENGINE</div>
</div>
<div style="font-family:var(--mono);font-size:11px">
<div id="sid"></div>
<div id="uptime"></div>
</div>
</header>

<div class="grid">

<!-- CART -->
<div class="panel">
<div class="p-head">CART</div>

<div id="cartVal" style="font-size:38px;color:var(--t1)">$100</div>
<input id="slider" type="range" min="10" max="500" value="100"/>

<div style="margin-top:10px">
<button class="btn" id="scoreBtn">SCORE</button>
<button class="btn" id="checkoutBtn" disabled>CHECKOUT</button>
</div>
</div>

<!-- DECISION -->
<div class="panel">
<div class="p-head">DECISION</div>

<div id="decision"></div>
<div id="details" style="margin-top:8px;font-family:var(--mono)"></div>
</div>

<!-- METRICS -->
<div class="panel">
<div class="p-head">METRICS</div>

<div class="metric"><div class="num" id="m1">—</div><div class="lbl">TOTAL</div></div>
<div class="metric"><div class="num" id="m2">—</div><div class="lbl">CONVERSIONS</div></div>
<div class="metric"><div class="num" id="m3">—</div><div class="lbl">RATE</div></div>
</div>

<!-- SIM -->
<div class="panel">
<div class="p-head">SIM</div>

<input id="simN" type="number" value="5" min="1" max="50"/>
<button class="btn" onclick="startSim()">START</button>
<button class="btn" onclick="stopSim()">STOP</button>

<div style="margin-top:8px;font-size:10px">
Active: <span id="simCount">0</span>
</div>
</div>

<!-- BANDIT -->
<div class="panel" style="grid-column:1/4">
<div class="p-head">BANDIT STATE</div>
<div id="bandit"></div>
</div>

<!-- LOG -->
<div class="panel" style="grid-column:1/4">
<div class="p-head">LOG</div>
<div id="log"></div>
</div>

</div>
</div>

<script>
let cart=100,decision=null;
const sid=localStorage.sid||(localStorage.sid=crypto.randomUUID());
sidEl.textContent="SID "+sid.slice(0,6);

const start=Date.now();
setInterval(()=>{
uptime.textContent="UP "+Math.floor((Date.now()-start)/1000)+"s";
},1000);

/* helpers */
function log(msg,type=""){
const d=document.createElement('div');
d.className="log "+type;
d.textContent=msg;
logEl.prepend(d);
}

function renderDecision(d){
decisionEl.innerHTML="";
const chip=document.createElement('span');
chip.className="chip";
chip.textContent=d.action;
decisionEl.appendChild(chip);

if(d.explored){
const e=document.createElement('span');
e.className="explore";
e.textContent="EXPLORE";
decisionEl.appendChild(e);
}

details.textContent=
"EV $"+d.expected_value.toFixed(2)+" · DISC "+(d.discount||0);
}

/* cart */
slider.oninput=e=>{
cart=e.target.value;
cartVal.textContent="$"+cart;
};

/* score */
scoreBtn.onclick=async()=>{
scoreBtn.disabled=true;

try{
const r=await fetch('/score',{
method:'POST',
headers:{'Content-Type':'application/json'},
body:JSON.stringify({session_id:sid,cart_value:cart})
});
const d=await r.json();

decision=d;
renderDecision(d);

checkoutBtn.disabled=false;
log("decision "+d.action,"ok");

}catch(e){log("score error","err");}

scoreBtn.disabled=false;
};

/* checkout */
checkoutBtn.onclick=async()=>{
if(!decision)return;

try{
await fetch('/action',{
method:'POST',
headers:{'Content-Type':'application/json'},
body:JSON.stringify({decision_id:decision.decision_id})
});

/* reward model */
const base=0.25;
const boost={
NONE:0,
INCENTIVE_LOW:0.08,
INCENTIVE_MED:0.15,
INCENTIVE_HIGH:0.22
};

const p=base+boost[decision.action];
const converted=Math.random()<p;
const revenue=converted?cart-(decision.discount||0):0;

await fetch('/outcome',{
method:'POST',
headers:{'Content-Type':'application/json'},
body:JSON.stringify({
decision_id:decision.decision_id,
converted,
revenue
})
});

log(converted?"converted":"lost",converted?"ok":"warn");

decision=null;
checkoutBtn.disabled=true;

}catch(e){log("checkout fail","err");}
};

/* metrics */
async function loadMetrics(){
try{
const r=await fetch('/metrics');
const m=await r.json();
m1.textContent=m.total;
m2.textContent=m.conversions;
m3.textContent=(m.conversion_rate*100).toFixed(1)+"%";
}catch{}
}

/* bandit */
async function loadBandit(){
try{
const r=await fetch('/metrics/bandit');
const data=await r.json();

bandit.innerHTML="";

data.forEach(a=>{
const row=document.createElement('div');
row.style.marginBottom='8px';

row.innerHTML=`
<div style="display:flex;justify-content:space-between;font-size:10px;font-family:var(--mono)">
<span>${a.action}</span>
<span>${(a.mean_reward*100).toFixed(1)}%</span>
</div>
<div class="bar">
<div class="fill" style="
left:${a.lower_bound*100}%;
width:${(a.upper_bound-a.lower_bound)*100}%;
"></div>
</div>
<div style="font-size:9px;color:var(--t2)">trials ${a.trials}</div>
`;

bandit.appendChild(row);
});

}catch{}
}

/* simulation */
let sims=[];
function startSim(){
stopSim();
const n=Number(simN.value);

for(let i=0;i<n;i++){
const sid=crypto.randomUUID();

const t=setInterval(async()=>{
const cart=Math.floor(Math.random()*400)+20;

try{
const s=await fetch('/score',{
method:'POST',
headers:{'Content-Type':'application/json'},
body:JSON.stringify({session_id:sid,cart_value:cart})
}).then(r=>r.json());

await fetch('/action',{
method:'POST',
headers:{'Content-Type':'application/json'},
body:JSON.stringify({decision_id:s.decision_id})
});

const base=0.25;
const boost={NONE:0,INCENTIVE_LOW:0.08,INCENTIVE_MED:0.15,INCENTIVE_HIGH:0.22};
const converted=Math.random()<(base+boost[s.action]);
const revenue=converted?cart-(s.discount||0):0;

await fetch('/outcome',{
method:'POST',
headers:{'Content-Type':'application/json'},
body:JSON.stringify({decision_id:s.decision_id,converted,revenue})
});

}catch{}

},1500+Math.random()*1000);

sims.push(t);
}

simCount.textContent=n;
}

function stopSim(){
sims.forEach(clearInterval);
sims=[];
simCount.textContent=0;
}

/* loop */
setInterval(()=>{
loadMetrics();
loadBandit();
},5000);

loadMetrics();
loadBandit();
</script>

</body>
</html>  
