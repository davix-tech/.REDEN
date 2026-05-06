<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>REDEN</title>

<style>
:root{
  --bg:#0a0f18;
  --panel:#0f1624;
  --border:#1f2a3a;
  --accent:#6c8dff;
  --text:#dbe6ff;
  --dim:#6b7c99;
}

*{box-sizing:border-box;margin:0;padding:0;}

body{
  background:var(--bg);
  color:var(--text);
  font-family:monospace;
  padding:20px;
}

/* layout */
.container{
  max-width:900px;
  margin:auto;
}

/* header */
.header{
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-bottom:20px;
}

.title{
  font-size:22px;
  letter-spacing:4px;
}

.status{
  color:#34d399;
  font-size:12px;
}

/* panel */
.panel{
  background:var(--panel);
  border:1px solid var(--border);
  padding:20px;
  margin-bottom:16px;
}

/* input */
input{
  width:100%;
  padding:10px;
  margin-top:10px;
  background:#0c1422;
  border:1px solid var(--border);
  color:white;
}

/* button */
button{
  margin-top:10px;
  padding:10px;
  width:100%;
  border:none;
  background:var(--accent);
  color:white;
  cursor:pointer;
}

button:disabled{
  opacity:0.5;
}

/* result */
.result{
  font-size:18px;
  margin-top:10px;
}

/* log */
.log{
  font-size:11px;
  color:var(--dim);
  max-height:200px;
  overflow:auto;
}
</style>
</head>

<body>

<div class="container">

  <!-- HEADER -->
  <div class="header">
    <div class="title">REDEN</div>
    <div class="status">● LIVE</div>
  </div>

  <!-- INPUT -->
  <div class="panel">
    <div>Cart Value</div>
    <input type="number" id="cart" value="100"/>
    <button onclick="score()">SCORE</button>
  </div>

  <!-- RESULT -->
  <div class="panel">
    <div>Decision</div>
    <div class="result" id="result">—</div>
  </div>

  <!-- LOG -->
  <div class="panel">
    <div>System Log</div>
    <div class="log" id="log"></div>
  </div>

</div>

<script>
const BASE = "https://reden-zljf.onrender.com";

let decision = null;

function log(msg){
  const el = document.getElementById("log");
  el.innerHTML = msg + "<br>" + el.innerHTML;
}

/* SAFE FETCH HANDLER */
async function safeFetch(url, options){
  const res = await fetch(url, options);

  const text = await res.text();

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Non-JSON response (likely HTML error page)");
  }
}

/* SCORE */
async function score(){
  const cart = Number(document.getElementById("cart").value);

  log("Scoring...");

  try {
    const data = await safeFetch(BASE + "/score", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({
        session_id:"frontend",
        cart_id:"cart_" + Date.now(),
        cart_value:cart
      })
    });

    decision = data;

    document.getElementById("result").innerText =
      data.action + " | $" + data.expected_value;

    log("Decision: " + data.action);

  } catch(e){
    log("ERROR: " + e.message);
  }
}
</script>

</body>
</html>
