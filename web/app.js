import {phraseCommand, parseBoardLine, makeWav} from './protocol.mjs';
const $ = id => document.getElementById(id);
const records = [];
let port=null, reader=null, writer=null, readTask=null, connected=false, closing=false, connecting=false;
let requestId=1, pending=new Map(), heartbeat=null, pollBusy=false, epoch=0, lastReport=0;
let stream=null, audioContext=null, audioNode=null, audioSource=null, silentGain=null;
let recording=false, chunks=[], recordTimer=null, held=false, recognizing=false, requestAbort=null;
let modelReady=false, userBusy=false;
const labels={BLUE_ON:'藍燈開啟',GREEN_ON:'綠燈開啟',BLUE_OFF:'藍燈關閉',GREEN_OFF:'綠燈關閉',BLUE_BLINK3:'藍燈閃爍三次',GREEN_BLINK3:'綠燈閃爍三次',ALL_OFF:'兩燈關閉'};
function log(source,message,kind='') {
  const entry={time:new Date().toISOString(),source,message,kind}; records.push(entry);
  if(records.length>1000) records.shift();
  $('log').querySelector('.empty')?.remove();
  const li=document.createElement('li');li.className=kind;
  [new Date(entry.time).toLocaleTimeString('zh-TW',{hour12:false}),source,message].forEach(text=>{const s=document.createElement('span');s.textContent=text;li.append(s);});
  $('log').prepend(li);while($('log').children.length>100)$('log').lastChild.remove();
}
function notice(message,kind=''){$('notice').textContent=message;$('notice').className=kind;}
function controls(){
  $('connect').disabled=connecting||connected||closing;
  $('enable-mic').disabled=!connected||!modelReady||!!stream||closing;
  $('record').disabled=!connected||!modelReady||!stream||recognizing||closing;
  document.querySelectorAll('[data-command]').forEach(b=>b.disabled=!connected||userBusy||closing);
}
function unknown(){
  for(const color of ['blue','green']){$(`${color}-indicator`).className='lamp-indicator unknown';$(`${color}-state`).textContent='未知';}
  $('last-report').textContent='目前無有效連線';
}
function showBoard(data){
  lastReport=Date.now();
  for(const color of ['blue','green']){
    $(`${color}-indicator`).className=`lamp-indicator ${data[color]?'on':'off'}`;
    $(`${color}-state`).textContent=(data[color]?'亮':'滅')+(data[`${color}Blinking`]?' · 閃爍中':'');
  }
  $('last-report').textContent=`回覆 ${new Date().toLocaleTimeString('zh-TW',{hour12:false})}`;
}
function receive(line){
  const data=parseBoardLine(line);if(!data)return;
  if(connected||connecting)showBoard(data);
  if(data.event==='ready'&&connected){void disconnect('開發板已重啟，請重新連接。',true);return;}
  const item=pending.get(data.id);
  if(item&&(data.event==='ack'||data.event==='error')){
    if(data.event==='ack'&&data.command!==item.command)return;
    clearTimeout(item.timer);pending.delete(data.id);
    if(data.event==='error')item.reject(new Error(`開發板拒絕指令：${data.error}`));else item.resolve(data);
  }
  if(data.event==='done')log('板端',`${labels[data.command]}完成；已熄滅。`,'success');
  if(data.event==='stopped')log('板端','未收到主機心跳，已停止閃爍。','error');
}
async function readLoop(activePort){
  const decoder=new TextDecoder();let buffer='';
  const activeReader=activePort.readable.getReader();reader=activeReader;
  try{
    while(true){const {value,done}=await activeReader.read();if(done)break;
      if(activePort!==port)break;
      buffer+=decoder.decode(value,{stream:true});let index;
      while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index).replace(/\r$/,'');buffer=buffer.slice(index+1);receive(line);}
      if(buffer.length>8192)buffer='';
    }
    if(!closing&&activePort===port)void disconnect('開發板連線已結束。',true);
  }catch(error){if(!closing&&activePort===port)void disconnect(`通訊失敗：${error.message}`,true);}
  finally{activeReader.releaseLock();if(reader===activeReader)reader=null;}
}
function send(command,timeout=1500){
  if(!writer||(!connected&&!connecting))return Promise.reject(new Error('尚未連接開發板'));
  const id=requestId++;if(requestId>999999999)requestId=1;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('開發板回覆逾時，請檢查 USB、RESET 與韌體版本。'));},timeout);
    pending.set(id,{resolve,reject,timer,command});
    writer.write(new TextEncoder().encode(`${id} ${command}\n`)).catch(error=>{
      const item=pending.get(id);if(item){clearTimeout(item.timer);pending.delete(id);item.reject(error);}
    });
  });
}
async function connect(){
  if(connecting||connected||closing)return;
  if(!navigator.serial){notice('請使用桌面版 Google Chrome 開啟此網站；此瀏覽器不支援 USB 序列通訊。','error');return;}
  connecting=true;const connectEpoch=++epoch;controls();notice('請選擇 AMB82-MINI 的 USB 序列埠。');
  try{
    const selectedPort=await navigator.serial.requestPort();
    if(epoch!==connectEpoch)return;
    await selectedPort.open({baudRate:115200});
    if(epoch!==connectEpoch){await selectedPort.close();return;}
    port=selectedPort;
    writer=port.writable.getWriter();readTask=readLoop(port);
    // 開埠可能觸發部分板子的 RESET，等待開機後只查詢狀態。
    await new Promise(resolve=>setTimeout(resolve,1200));
    if(epoch!==connectEpoch)return;
    if(closing||!port)throw new Error('連線已取消');
    await send('STATUS',2500);
    connected=true;$('connection-status').textContent='AMB82-MINI 已連接';$('connection-dot').classList.add('connected');
    notice('連線成功。啟用麥克風後，按住說話。','success');log('連線','已收到 v3 韌體回覆。','success');
    heartbeat=setInterval(async()=>{
      if(!connected||closing||pollBusy)return;pollBusy=true;
      try{await send('STATUS');}catch(error){if(!closing)void disconnect(error.message,true);}finally{pollBusy=false;}
    },1000);
  }catch(error){if(epoch!==connectEpoch)return;if(error.name==='NotFoundError'){notice('未選擇開發板，可再次按「連接」。');}else{notice(`連線失敗：${error.message} 請確認已上傳 03_voice_led，並關閉 Arduino 序列埠監控視窗。`,'error');log('連線',error.message,'error');}
    await disconnect(null,false);
  }finally{if(epoch===connectEpoch)connecting=false;controls();}
}
function releaseMicrophone(){
  held=false;recording=false;clearTimeout(recordTimer);chunks=[];
  audioNode?.disconnect();audioSource?.disconnect();silentGain?.disconnect();
  stream?.getTracks().forEach(track=>track.stop());stream=null;
  if(audioContext)void audioContext.close().catch(()=>{});
  audioContext=null;audioNode=null;audioSource=null;silentGain=null;
  $('record').classList.remove('recording');$('record-label').textContent='按住說話';$('volume').value=0;
  $('speech-status').textContent='麥克風已停止';
}
async function disconnect(message='已停止收音、控制與連線。',failure=false){
  if(closing)return;closing=true;epoch++;
  clearInterval(heartbeat);heartbeat=null;requestAbort?.abort();requestAbort=null;recognizing=false;releaseMicrophone();controls();
  const hadConnection=connected;
  for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error('連線已停止'));}pending.clear();
  let stopConfirmed=false;
  // STOP 取消板端排程，保留當下燈號；無法傳達時不宣稱板子已停止。
  if(hadConnection&&writer&&!failure){try{await send('STOP',900);stopConfirmed=true;}catch{}}
  connected=false;connecting=false;
  const activePort=port;
  try{await reader?.cancel();}catch{}
  try{await readTask;}catch{}
  try{writer?.releaseLock();}catch{}writer=null;
  try{await activePort?.close();}catch{}port=null;readTask=null;
  $('connection-status').textContent=failure?'通訊中斷':'尚未連接開發板';$('connection-dot').classList.remove('connected');unknown();
  closing=false;userBusy=false;controls();
  if(message){
    const detail=hadConnection&&!failure&&!stopConfirmed?' 未收到停止確認，板端若仍供電，心跳逾時後會停止閃爍。':'';
    notice(message+detail,failure?'error':'');log('連線',message+detail,failure?'error':'');
  }
}
async function execute(command,source){
  if(command==='STOP'){await disconnect('已辨識「通訊中斷」：停止收音、控制與連線。');return;}
  if(!connected||closing){notice('尚未連接開發板，沒有送出控制指令。','error');return;}
  if(userBusy){notice('上一個指令尚未回覆，本次不執行，請再說一次。');log(source,'忙碌中，拒絕新指令。');return;}
  const currentEpoch=epoch;userBusy=true;controls();
  log(source,`送出 ${command}，等待開發板回覆。`);
  try{await send(command);
    if(epoch!==currentEpoch)return;
    const text=`開發板已確認：${labels[command]??command}${command.endsWith('BLINK3')?'，執行中。':'。'}`;
    notice(text,'success');$('decision').textContent=text;log('板端',text,'success');
  }catch(error){if(epoch===currentEpoch&&!closing)await disconnect(error.message,true);}
  finally{if(epoch===currentEpoch){userBusy=false;controls();}}
}
async function enableMicrophone(){
  if(!connected||stream||!modelReady)return;
  const currentEpoch=epoch;
  try{
    const capture=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true}});
    if(epoch!==currentEpoch||!connected){capture.getTracks().forEach(t=>t.stop());return;}
    stream=capture;audioContext=new AudioContext();await audioContext.audioWorklet.addModule('/audio-worklet.js');
    if(epoch!==currentEpoch||!stream){releaseMicrophone();return;}
    audioSource=audioContext.createMediaStreamSource(stream);audioNode=new AudioWorkletNode(audioContext,'local-recorder');
    silentGain=audioContext.createGain();silentGain.gain.value=0;
    audioSource.connect(audioNode);audioNode.connect(silentGain);silentGain.connect(audioContext.destination);
    audioNode.port.onmessage=event=>{
      const samples=event.data;
      if(recording){chunks.push(samples);let sum=0;for(const v of samples)sum+=v*v;$('volume').value=Math.min(1,Math.sqrt(sum/samples.length)*8);}
    };
    stream.getAudioTracks()[0].addEventListener('ended',()=>{if(stream){releaseMicrophone();controls();notice('麥克風已中斷，請重新啟用。','error');}});
    $('speech-status').textContent='麥克風就緒';notice('按住「按住說話」，說完後放開。');log('麥克風','已啟用；只有按住時的錄音會交給本機模型。');controls();
  }catch(error){releaseMicrophone();controls();notice(`無法使用麥克風：${error.name==='NotAllowedError'?'請允許 Chrome 的麥克風權限。':error.message}`,'error');}
}
async function startRecording(){
  if(recording||recognizing||!stream||!connected||!modelReady)return;
  held=true;const currentEpoch=epoch;await audioContext.resume();
  if(!held||currentEpoch!==epoch||!stream)return;
  recording=true;chunks=[];$('record').classList.add('recording');$('record-label').textContent='正在聆聽 · 放開辨識';$('speech-status').textContent='錄音中';
  $('decision').textContent='請說一句指令。';
  recordTimer=setTimeout(()=>void finishRecording(),10000);
}
async function finishRecording(cancel=false){
  held=false;if(!recording)return;recording=false;clearTimeout(recordTimer);
  $('record').classList.remove('recording');$('record-label').textContent='按住說話';$('volume').value=0;
  const captured=chunks;chunks=[];const rate=audioContext?.sampleRate;
  if(cancel||!connected||!rate){$('speech-status').textContent='錄音已取消';return;}
  const blob=makeWav(captured,rate);if(blob.size<8044){notice('錄音太短，請按住按鈕說完一句話。');$('speech-status').textContent='麥克風就緒';return;}
  recognizing=true;const currentEpoch=epoch;const abort=new AbortController();requestAbort=abort;controls();
  $('speech-status').textContent='本機辨識中…';$('transcript').textContent='正在辨識…';
  const timeout=setTimeout(()=>abort.abort(),60000);
  try{
    const response=await fetch('/api/transcribe',{method:'POST',headers:{'Content-Type':'audio/wav'},body:blob,signal:abort.signal});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'辨識失敗');
    if(epoch!==currentEpoch||!connected)return;
    $('transcript').textContent=result.text||'（沒有辨識到語句）';log('語音',result.text||'沒有辨識到語句');
    if(!result.reliable){$('decision').textContent=result.reason;notice(result.reason+'；LED 狀態不變。');log('判斷','辨識不可靠，沒有送出指令。');return;}
    const command=phraseCommand(result.text);
    if(!command){$('decision').textContent='非支援指令，未送出控制。';notice('這句話不在指令清單中，LED 狀態不變。');log('判斷','非控制語句，沒有送出指令。');return;}
    await execute(command,'語音');
  }catch(error){if(epoch===currentEpoch){notice(error.name==='AbortError'?'辨識逾時，沒有送出指令。':`語音辨識失敗：${error.message}`,'error');$('decision').textContent='本次未執行控制。';log('辨識','辨識失敗或逾時，沒有送出指令。','error');}}
  finally{clearTimeout(timeout);if(epoch===currentEpoch){recognizing=false;requestAbort=null;$('speech-status').textContent=stream?'麥克風就緒':'麥克風已停止';controls();}}
}
async function health(){
  try{const response=await fetch('/api/health',{signal:AbortSignal.timeout(3000)});if(!response.ok)throw new Error();const data=await response.json();modelReady=data.state==='ready';
    $('model-status').textContent=modelReady?`Whisper ${data.model} · 本機模型已就緒`:data.state==='error'?'模型載入失敗，請查看終端機':'正在載入／下載本機模型，首次需要較久時間…';
  }catch{modelReady=false;$('model-status').textContent='本機辨識服務未連線，請啟動 start.command';}controls();
}
$('connect').addEventListener('click',()=>void connect());
$('stop').addEventListener('click',()=>void disconnect());
$('enable-mic').addEventListener('click',()=>void enableMicrophone());
$('record').addEventListener('pointerdown',event=>{if(event.button!==0)return;event.preventDefault();$('record').setPointerCapture(event.pointerId);void startRecording();});
$('record').addEventListener('pointerup',()=>void finishRecording());
$('record').addEventListener('pointercancel',()=>void finishRecording(true));
window.addEventListener('keydown',event=>{if(event.code==='Space'&&!event.repeat&&!/INPUT|TEXTAREA/.test(event.target.tagName)&&!$('record').disabled){event.preventDefault();void startRecording();}});
window.addEventListener('keyup',event=>{if(event.code==='Space'&&held){event.preventDefault();void finishRecording();}});
window.addEventListener('blur',()=>void finishRecording(true));
document.querySelectorAll('[data-command]').forEach(button=>button.addEventListener('click',()=>void execute(button.dataset.command,'按鈕')));
navigator.serial?.addEventListener('disconnect',event=>{if(event.target===port||event.port===port)void disconnect('USB 已拔除或連線中斷，LED 目前狀態未知。',true);});
$('export').addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([JSON.stringify({exportedAt:new Date().toISOString(),records},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='ameba-test-log.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
window.addEventListener('pagehide',()=>{releaseMicrophone();requestAbort?.abort();});
void health();setInterval(()=>void health(),5000);controls();
