/*
 * D3.js v7: linked charts, keyed data joins, transitions, brush and playback.
 * The same offline data snapshot is used by CSV export, figures and summaries.
 */

(function() {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const M = window.AQIModel;
  const colorPalette = ['#3c8a78','#779ab1','#dc9b45','#9877a9','#d57a60','#6a88a9'];
  const defaultIds = ['15','31','56','63'];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const dateLabel = d => M.dateKey(+d).replaceAll('-',' / ');
  const shortDate = d => M.dateKey(+d).slice(5).replace('-','/');
  const valueLabel = n => Number.isFinite(n) ? Number.isInteger(n) ? String(n) : n.toFixed(1) : '—';
  const percent = n => n === null ? '—' : (n*100).toFixed(1);
  let rows, metadata, stations, byStation, byDay, MIN, MAX, yMax, state;
  let timer = null, trendX, trendY, trendBounds, overviewX, brush, syncingBrush = false;
  let resizeFrame;

  function announce(message) { $('#status-message').textContent = message; }
  function selectedStations() { return stations.filter(s=>state.selected.includes(s.id)); }
  function atDay(id, day) { return byDay.get(day)?.get(id)?.aqi ?? null; }
  function clampDay(day) { return Math.min(MAX,Math.max(MIN,day)); }
  function daysInRange() { return Math.round((state.end-state.start)/M.DAY)+1; }
  function setPlaying(value) {
    if (timer) { clearInterval(timer); timer = null; }
    state.playing = value;
    $('#play .play-symbol').textContent = value ? 'Ⅱ' : '▶';
    $('#play .play-text').textContent = value ? '暫停' : '播放';
    $('#play').setAttribute('aria-label',value?'暫停每日變化':'播放每日變化');
    if (value) {
      if (state.current >= state.end) state.current = state.start;
      renderCurrent(false);
      timer = setInterval(()=>{
        state.current = Math.min(state.end,state.current+M.DAY);
        renderCurrent(true);
        if (state.current >= state.end) { setPlaying(false); announce('已播放至所選期間的最後一天。'); }
      },state.speed);
    }
  }
  function setCurrent(day, animate=false) {
    state.current = Math.min(state.end,Math.max(state.start,day));
    renderCurrent(animate);
  }
  function setRange(start,end,{syncBrush=true,from='range'}={}) {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return syncControls();
    setPlaying(false);
    start=clampDay(start); end=clampDay(end);
    if(start>end) { if(from==='start') end=start; else start=end; }
    state.start=start; state.end=end;
    state.current=Math.min(end,Math.max(start,state.current));
    renderAll(syncBrush);
  }
  function setSelected(ids) {
    if (!ids.length) { announce('至少保留一個測站，才能進行比較。'); syncControls(); return; }
    setPlaying(false);
    state.selected=stations.filter(s=>ids.includes(s.id)).map(s=>s.id);
    renderAll();
    announce(`目前比較 ${state.selected.length} 個測站。`);
  }
  function reset() {
    setPlaying(false);
    state.selected=defaultIds.filter(id=>stations.some(s=>s.id===id));
    state.start=MIN; state.end=M.dateMs('2025-03-31'); state.current=M.dateMs('2025-01-22');
    state.speed=600; $('#play-speed').value='600';
    renderAll(); announce('已恢復預設四站、1 至 3 月及 1 月 22 日。');
  }

  function syncControls() {
    d3.selectAll('.station-option input').property('checked',d=>state.selected.includes(d.id));
    $('#selected-count').textContent=`${state.selected.length} / ${stations.length}`;
    $('#start-date').value=M.dateKey(state.start); $('#end-date').value=M.dateKey(state.end);
    const presets={all:[MIN,MAX],q1:[MIN,M.dateMs('2025-03-31')],q2:[M.dateMs('2025-04-01'),M.dateMs('2025-06-30')],q3:[M.dateMs('2025-07-01'),M.dateMs('2025-09-30')],q4:[M.dateMs('2025-10-01'),MAX]};
    d3.selectAll('#range-presets button').classed('active',function(){const r=presets[this.dataset.range]; return r[0]===state.start&&r[1]===state.end;}).attr('aria-pressed',function(){return this.classList.contains('active')?'true':'false';});
    $('#trend-range').textContent=`${shortDate(state.start)} — ${shortDate(state.end)}`;
    const legend=d3.select('#chart-legend').selectAll('.legend-item').data(selectedStations(),d=>d.id).join(enter=>{
      const item=enter.append('span').attr('class','legend-item'); item.append('i');item.append('span');return item;
    });
    legend.select('i').style('background',d=>d.color);legend.select('span').text(d=>`${d.name} · ${d.county.replace(/[市縣]$/,'')}`);
  }

  function renderSummary() {
    const summary=M.summarize(rows,state.start,state.end,state.selected);
    $('#stat-stations').textContent=state.selected.length;
    $('#stat-days').textContent=summary.days;
    $('#stat-period').textContent=`2025 / ${shortDate(state.start)} — ${shortDate(state.end)}`;
    $('#stat-coverage').textContent=percent(summary.coverage);
    $('#stat-valid').textContent=`${summary.valid.toLocaleString()} / ${summary.expected.toLocaleString()} 有效觀測站日`;
    $('#stat-rate').textContent=percent(summary.ratio);
    $('#stat-above').textContent=`${summary.above.toLocaleString()} / ${summary.valid.toLocaleString()} 有效觀測站日`;
    const tableRows=summary.stations.map(s=>({...stations.find(x=>x.id===s.id),...s}));
    const tr=d3.select('#summary-body').selectAll('tr').data(tableRows,d=>d.id).join(enter=>{
      const r=enter.append('tr');const td=r.append('td');const label=td.append('span').attr('class','table-station');label.append('i');label.append('span');
      r.append('td').attr('class','median-cell');r.append('td').attr('class','rate-cell');r.append('td').attr('class','coverage-cell');return r;
    });
    tr.select('.table-station i').style('background',d=>d.color);
    tr.select('.table-station span').text(d=>d.name);
    tr.select('.median-cell').text(d=>valueLabel(d.median));
    tr.select('.rate-cell').text(d=>d.ratio===null?'—':`${percent(d.ratio)}%`).attr('title',d=>`${d.above} / ${d.valid} 有效日`);
    tr.select('.coverage-cell').text(d=>`${d.valid} / ${summary.days}`).attr('title',d=>`缺失 ${d.missing} 天`);
  }

  function ensureTrendLayers(svg) {
    const defs=svg.selectAll('defs').data([null]).join('defs');
    defs.selectAll('clipPath').data([null]).join('clipPath').attr('id','trend-clip').selectAll('rect').data([null]).join('rect');
    for(const name of ['grid','x-axis','reference','lines','points','cursor','hover','interaction']) svg.selectAll(`g.${name}`).data([null]).join('g').attr('class',name);
    svg.select('.x-axis').classed('axis',true);
    svg.select('.lines').attr('clip-path','url(#trend-clip)');
    svg.select('.points').attr('clip-path','url(#trend-clip)');
  }
  function renderTrend() {
    const svg=d3.select('#trend-chart');ensureTrendLayers(svg);
    const box=$('#trend-chart').getBoundingClientRect();const w=Math.max(260,box.width),h=box.height;
    const m={left:34,right:18,top:20,bottom:26};trendBounds={w,h,m};svg.attr('viewBox',`0 0 ${w} ${h}`);
    trendX=d3.scaleUtc().domain(state.start===state.end?[state.start-M.DAY/2,state.end+M.DAY/2]:[state.start,state.end]).range([m.left,w-m.right]);
    trendY=d3.scaleLinear().domain([0,yMax]).range([h-m.bottom,m.top]);
    svg.select('#trend-clip rect').attr('x',m.left-3).attr('y',m.top-3).attr('width',w-m.left-m.right+6).attr('height',h-m.top-m.bottom+6);
    svg.select('.grid').attr('transform',`translate(${m.left},0)`).call(d3.axisLeft(trendY).tickValues(d3.range(0,yMax+1,50)).tickSize(-(w-m.left-m.right)).tickPadding(9));
    const ticks=state.start===state.end?[new Date(state.start)]:undefined;
    const axis=d3.axisBottom(trendX).ticks(Math.max(3,Math.floor(w/95))).tickSize(0).tickPadding(12).tickFormat(d=>shortDate(d));
    if(ticks)axis.tickValues(ticks);
    svg.select('.x-axis').attr('transform',`translate(0,${h-m.bottom})`).call(axis);
    svg.selectAll('.axis-title').data([null]).join('text').attr('class','axis-title').attr('x',m.left).attr('y',9).text('AQI');
    const ref=svg.select('.reference');
    ref.selectAll('line').data([100]).join('line').attr('class','reference-line').attr('x1',m.left).attr('x2',w-m.right).attr('y1',trendY(100)).attr('y2',trendY(100));
    ref.selectAll('text').data([100]).join('text').attr('class','reference-label').attr('x',w-m.right-2).attr('y',trendY(100)-6).attr('text-anchor','end').text('100');
    const series=selectedStations().map(s=>({...s,values:byStation.get(s.id).filter(d=>d.day>=state.start&&d.day<=state.end)}));
    const line=d3.line().defined(d=>Number.isFinite(d.aqi)).x(d=>trendX(d.day)).y(d=>trendY(d.aqi));
    svg.select('.lines').selectAll('path').data(series,d=>d.id).join('path').attr('class','trend-line').attr('stroke',d=>d.color).attr('d',d=>line(d.values));
    // Single-day ranges need marks: a one-point path has no visible segment.
    const single=state.start===state.end?series.filter(s=>Number.isFinite(s.values[0]?.aqi)):[];
    svg.select('.points').selectAll('circle').data(single,d=>d.id).join('circle').attr('cx',d=>trendX(d.values[0].day)).attr('cy',d=>trendY(d.values[0].aqi)).attr('r',4).attr('fill',d=>d.color).attr('stroke','white').attr('stroke-width',1);
    svg.select('.cursor').selectAll('line').data([null]).join('line').attr('class','current-cursor').attr('y1',m.top).attr('y2',h-m.bottom);
    const noData=!series.some(s=>s.values.some(d=>Number.isFinite(d.aqi)));
    svg.selectAll('.empty-label').data(noData?[null]:[]).join('text').attr('class','empty-label').attr('x',(m.left+w-m.right)/2).attr('y',h/2).attr('text-anchor','middle').attr('fill','#8c9c80').attr('font-size',12).text('所選期間沒有有效觀測資料');
    const overlay=svg.select('.interaction').selectAll('rect').data([null]).join('rect').attr('x',m.left).attr('y',m.top).attr('width',w-m.left-m.right).attr('height',h-m.top-m.bottom).attr('fill','transparent').style('cursor','crosshair');
    overlay.on('pointermove',event=>{
      const [px]=d3.pointer(event,$('#trend-chart'));const day=Math.min(state.end,Math.max(state.start,Math.round((+trendX.invert(px)-MIN)/M.DAY)*M.DAY+MIN));
      showTooltip(day,event);
    }).on('pointerleave',hideTooltip).on('click',event=>{
      const [px]=d3.pointer(event,$('#trend-chart'));const day=Math.round((+trendX.invert(px)-MIN)/M.DAY)*M.DAY+MIN;
      setPlaying(false);setCurrent(day,true);announce(`已選擇 ${M.dateKey(state.current)}。`);
    });
    $('#trend-chart').setAttribute('aria-label',`${M.dateKey(state.start)} 至 ${M.dateKey(state.end)}，${selectedStations().map(s=>s.name).join('、')}的每日 AQI 趨勢；資料詳見下方統計與匯出 CSV。`);
    hideTooltip();
  }
  function showTooltip(day,event) {
    const tooltip=$('#chart-tooltip');tooltip.hidden=false;tooltip.replaceChildren();
    const title=document.createElement('div');title.className='tooltip-date';title.textContent=dateLabel(day);tooltip.append(title);
    for(const s of selectedStations()){
      const row=document.createElement('div');row.className='tooltip-row';const dot=document.createElement('i');dot.style.background=s.color;
      const name=document.createElement('span');name.textContent=s.name;const value=document.createElement('strong');const v=atDay(s.id,day);value.textContent=Number.isFinite(v)?v:'無資料';row.append(dot,name,value);tooltip.append(row);
    }
    const wrap=$('.chart-wrap').getBoundingClientRect();let left=event.clientX-wrap.left+16;
    if(left+tooltip.offsetWidth>wrap.width)left=event.clientX-wrap.left-tooltip.offsetWidth-16;
    tooltip.style.left=`${Math.max(0,left)}px`;tooltip.style.top=`${Math.max(2,Math.min(wrap.height-tooltip.offsetHeight-5,event.clientY-wrap.top-35))}px`;
    const h=d3.select('#trend-chart .hover');h.selectAll('line').data([day]).join('line').attr('class','hover-line').attr('x1',trendX(day)).attr('x2',trendX(day)).attr('y1',trendBounds.m.top).attr('y2',trendBounds.h-trendBounds.m.bottom);
    h.selectAll('circle').data(selectedStations().map(s=>({...s,aqi:atDay(s.id,day)})).filter(s=>Number.isFinite(s.aqi)),d=>d.id).join('circle').attr('cx',trendX(day)).attr('cy',d=>trendY(d.aqi)).attr('r',3.3).attr('fill',d=>d.color).attr('stroke','white').attr('stroke-width',1.5);
  }
  function hideTooltip(){ $('#chart-tooltip').hidden=true; d3.select('#trend-chart .hover').selectAll('*').remove(); }

  function renderOverview(sync=true) {
    const svg=d3.select('#overview-chart'),box=$('#overview-chart').getBoundingClientRect(),w=Math.max(260,box.width),h=box.height;
    const m={left:34,right:18,top:3,bottom:20};svg.attr('viewBox',`0 0 ${w} ${h}`);
    overviewX=d3.scaleUtc().domain([MIN-M.DAY/2,MAX+M.DAY/2]).range([m.left,w-m.right]);
    const y=d3.scaleLinear().domain([0,yMax]).range([h-m.bottom,m.top]);
    const values=d3.range(MIN,MAX+M.DAY,M.DAY).map(day=>({day,aqi:M.median(state.selected.map(id=>atDay(id,day)))}));
    svg.selectAll('.overview-area').data([values]).join('path').attr('class','overview-area').attr('d',d3.area().defined(d=>Number.isFinite(d.aqi)).x(d=>overviewX(d.day)).y0(h-m.bottom).y1(d=>y(d.aqi)));
    svg.selectAll('.overview-line').data([values]).join('path').attr('class','overview-line').attr('d',d3.line().defined(d=>Number.isFinite(d.aqi)).x(d=>overviewX(d.day)).y(d=>y(d.aqi)));
    svg.selectAll('.axis').data([null]).join('g').attr('class','axis').attr('transform',`translate(0,${h-m.bottom})`).call(d3.axisBottom(overviewX).ticks(d3.utcMonth.every(w<500?2:1)).tickSize(0).tickPadding(8).tickFormat(d=>`${d.getUTCMonth()+1}月`));
    if(!brush){
      brush=d3.brushX().on('brush end',event=>{
        if(syncingBrush || !event.sourceEvent)return;
        if(!event.selection){ if(event.type==='end')setRange(MIN,MAX); return; }
        const a=+overviewX.invert(event.selection[0]),b=+overviewX.invert(event.selection[1]);
        let start=clampDay(MIN+Math.floor((a-MIN+M.DAY/2)/M.DAY)*M.DAY);
        let end=clampDay(MIN+Math.ceil((b-MIN-M.DAY/2)/M.DAY)*M.DAY);
        if(start>end)end=start;
        setRange(start,end,{syncBrush:false});
        if(event.type==='end'){syncBrushSelection();announce(`觀察期間已更新為 ${M.dateKey(state.start)} 至 ${M.dateKey(state.end)}。`);}
      });
    }
    brush.extent([[m.left,m.top],[w-m.right,h-m.bottom]]).handleSize(5);
    svg.selectAll('.brush').data([null]).join('g').attr('class','brush').call(brush);
    if(sync)syncBrushSelection();
  }
  function syncBrushSelection(){
    syncingBrush=true;
    d3.select('#overview-chart .brush').call(brush.move,[overviewX(state.start-M.DAY/2),overviewX(state.end+M.DAY/2)]);
    syncingBrush=false;
  }

  function renderDaily(animate) {
    const svg=d3.select('#daily-chart'),box=$('#daily-chart').getBoundingClientRect(),w=Math.max(240,box.width),h=box.height;
    const m={left:42,right:35,top:5,bottom:25},chosen=selectedStations().map(s=>({...s,aqi:atDay(s.id,state.current)}));
    svg.attr('viewBox',`0 0 ${w} ${h}`);
    const x=d3.scaleLinear().domain([0,yMax]).range([m.left,w-m.right]);
    const y=d3.scaleBand().domain(chosen.map(s=>s.id)).range([m.top,h-m.bottom]).padding(.38);
    svg.selectAll('.axis').data([null]).join('g').attr('class','axis').attr('transform',`translate(0,${h-m.bottom+2})`).call(d3.axisBottom(x).tickValues(d3.range(0,yMax+1,50)).tickSize(0).tickPadding(10));
    svg.selectAll('.daily-reference').data([100]).join('line').attr('class','daily-reference reference-line').attr('x1',x(100)).attr('x2',x(100)).attr('y1',m.top).attr('y2',h-m.bottom);
    const group=svg.selectAll('.bar-row').data(chosen,d=>d.id).join(enter=>{
      const g=enter.append('g').attr('class','bar-row');g.append('text').attr('class','bar-label');g.append('rect').attr('class','bar-track');g.append('rect').attr('class','bar-fill').attr('width',0);g.append('text').attr('class','bar-value');return g;
    }).attr('transform',d=>`translate(0,${y(d.id)})`);
    const height=Math.min(23,y.bandwidth()),offset=(y.bandwidth()-height)/2;
    group.select('.bar-label').attr('x',m.left-10).attr('y',y.bandwidth()/2).attr('dy','.35em').attr('text-anchor','end').text(d=>d.name);
    group.select('.bar-track').attr('x',m.left).attr('y',offset).attr('height',height).attr('width',w-m.left-m.right).attr('rx',3);
    const bars=group.select('.bar-fill').attr('x',m.left).attr('y',offset).attr('height',height).attr('fill',d=>d.color);
    bars.interrupt();
    const target=animate&&!reducedMotion.matches?bars.transition().duration(Math.min(250,state.speed*.65)).ease(d3.easeCubicOut):bars;
    target.attr('width',d=>Number.isFinite(d.aqi)?Math.max(0,x(d.aqi)-m.left):0);
    group.select('.bar-value').attr('x',d=>Number.isFinite(d.aqi)?x(d.aqi)+7:m.left+9).attr('y',y.bandwidth()/2).attr('dy','.35em').classed('daily-missing',d=>!Number.isFinite(d.aqi)).text(d=>Number.isFinite(d.aqi)?d.aqi:'無資料');
    const valid=chosen.filter(s=>Number.isFinite(s.aqi));
    const insight=$('#daily-insight');insight.replaceChildren();
    if(!valid.length)insight.textContent='這一天所選測站皆無有效觀測資料。';
    else{
      const max=d3.max(valid,d=>d.aqi),top=valid.filter(s=>s.aqi===max);const strong=document.createElement('strong');strong.textContent=`${top.map(s=>s.name).join('、')} ${max}`;
      insight.append(document.createTextNode('當日所選測站最高：'),strong,document.createTextNode(` · ${valid.length} / ${chosen.length} 站有資料`));
    }
    $('#daily-chart').setAttribute('aria-label',`${M.dateKey(state.current)}：${chosen.map(s=>`${s.name} ${Number.isFinite(s.aqi)?s.aqi:'無資料'}`).join('，')}。`);
  }
  function renderCurrent(animate=false) {
    $('#play-date').textContent=dateLabel(state.current);
    $('#daily-date').textContent=M.dateKey(state.current).replaceAll('-','.');
    $('#play-position').textContent=`第 ${Math.round((state.current-state.start)/M.DAY)+1} / ${daysInRange()} 天`;
    $('#date-slider').max=daysInRange()-1;$('#date-slider').value=Math.round((state.current-state.start)/M.DAY);
    $('#date-slider').setAttribute('aria-valuetext',M.dateKey(state.current));
    $('#slider-start').textContent=M.dateKey(state.start);$('#slider-end').textContent=M.dateKey(state.end);
    $('#previous-day').disabled=state.current<=state.start;$('#next-day').disabled=state.current>=state.end;
    $('#play').disabled=state.start===state.end;$('#date-slider').disabled=state.start===state.end;
    d3.select('#trend-chart .current-cursor').attr('x1',trendX(state.current)).attr('x2',trendX(state.current));
    renderDaily(animate);
  }
  function renderAll(syncBrush=true) { syncControls();renderSummary();renderTrend();renderOverview(syncBrush);renderCurrent(); }

  function downloadCsv() {
    const data=rows.filter(d=>state.selected.includes(d.siteId)&&d.day>=state.start&&d.day<=state.end).map(d=>({date:d.date,siteId:d.siteId,siteName:d.siteName,aqi:d.aqi??''}));
    const blob=new Blob(['\uFEFF'+d3.csvFormat(data)],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob);
    const link=document.createElement('a');link.href=url;link.download=`AQI_${M.dateKey(state.start)}_${M.dateKey(state.end)}_${state.selected.length}stations.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    announce(`已匯出 ${data.length} 筆測站日紀錄，缺失 AQI 保留空欄。`);
  }
  function openDialog(id){setPlaying(false);hideTooltip();$(id).showModal();}
  function wireControls() {
    const labels=d3.select('#station-controls').selectAll('label').data(stations,d=>d.id).join('label').attr('class','station-option');
    labels.append('input').attr('type','checkbox').attr('value',d=>d.id).attr('aria-label',d=>`${d.name}，${d.county}`).on('change',event=>{
      const ids=Array.from(document.querySelectorAll('.station-option input:checked'),el=>el.value);setSelected(ids);
    });
    labels.append('i').attr('class','station-swatch').style('background',d=>d.color);labels.append('span').attr('class','station-name').text(d=>d.name);labels.append('small').text(d=>d.county.replace(/[市縣]$/,''));
    $('#start-date').addEventListener('change',event=>setRange(M.dateMs(event.target.value),state.end,{from:'start'}));
    $('#end-date').addEventListener('change',event=>setRange(state.start,M.dateMs(event.target.value),{from:'end'}));
    $('#select-all').addEventListener('click',()=>setSelected(stations.map(s=>s.id)));
    $('#select-default').addEventListener('click',()=>setSelected(defaultIds));
    $('#reset').addEventListener('click',reset);$('#overview-reset').addEventListener('click',()=>setRange(MIN,MAX));
    $('#range-presets').addEventListener('click',event=>{
      const key=event.target.dataset.range;if(!key)return;
      if(key==='all')return setRange(MIN,MAX);
      const q=Number(key.slice(1)),start=Date.UTC(2025,(q-1)*3,1),end=Date.UTC(2025,q*3,0);setRange(start,end);
    });
    $('#date-slider').addEventListener('input',event=>{setPlaying(false);setCurrent(state.start+Number(event.target.value)*M.DAY,false);});
    $('#play').addEventListener('click',()=>setPlaying(!state.playing));
    $('#play-speed').addEventListener('change',event=>{state.speed=Number(event.target.value);if(state.playing)setPlaying(true);});
    $('#previous-day').addEventListener('click',()=>{setPlaying(false);setCurrent(state.current-M.DAY,true);});
    $('#next-day').addEventListener('click',()=>{setPlaying(false);setCurrent(state.current+M.DAY,true);});
    $('#export-csv').addEventListener('click',downloadCsv);
    $('#methods-open').addEventListener('click',()=>openDialog('#methods-dialog'));
    $('#help-open').addEventListener('click',()=>openDialog('#help-dialog'));
    document.querySelectorAll('.dialog-close').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
    document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{
      if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();
    }));
    document.addEventListener('visibilitychange',()=>{if(document.hidden)setPlaying(false);});
    new ResizeObserver(()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>{renderTrend();renderOverview();renderCurrent();});}).observe($('.dashboard'));
  }
  function populateProvenance(){
    const dl=document.createElement('dl');dl.className='provenance-grid';
    const items=[['資 料 集',metadata.title],
                 ['發布單位',metadata.publisher],
                 ['資料期間',`${metadata.period.start} ~ ${metadata.period.end}`],
                 ['下載時間',new Intl.DateTimeFormat('zh-TW',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Taipei'}).format(new Date(metadata.retrievedAt))+' (台北)'],
                 ['資料筆數',`${rows.length.toLocaleString()} 筆 (${rows.filter(d=>Number.isFinite(d.aqi)).length.toLocaleString()} 筆有效值)`],
                 ['已知缺失','2025-02-02：六個測站皆無來源紀錄'],
                 ['測站選擇',metadata.selectionRationale]];
    for(const [key,value]of items){const dt=document.createElement('dt');dt.textContent=key;const dd=document.createElement('dd');dd.textContent=value;dl.append(dt,dd);}
    const source=document.createElement('p');source.style.marginTop='16px';
    for(const [label,url]of [['官方日 AQI',metadata.sourceUrl],['測站基本資料',metadata.stationSourceUrl],['資料授權',metadata.licenseUrl]]){
      const a=document.createElement('a');a.textContent=label;a.href=url;a.target='_blank';a.rel='noopener noreferrer';source.append(a,document.createTextNode('　'));
    }
    $('#data-provenance').append(dl,source);
  }
  async function init(){
    if(!window.d3||!M)throw new Error('D3 或資料處理程式未載入，請確認專案檔案是否完整。');
    if(window.AQI_BUNDLE){metadata=window.AQI_BUNDLE.metadata;rows=M.normalizeRows(d3.csvParse(window.AQI_BUNDLE.csv));}
    else {const result=await Promise.all([d3.json('data/metadata.json'),d3.csv('data/aqi-2025.csv')]);metadata=result[0];rows=M.normalizeRows(result[1]);}
    stations=metadata.stations.map((s,i)=>({...s,id:String(s.id),color:colorPalette[i%colorPalette.length]}));
    MIN=M.dateMs(metadata.period.start);MAX=M.dateMs(metadata.period.end);
    byStation=d3.group(rows,d=>d.siteId);byDay=d3.rollup(rows,v=>new Map(v.map(d=>[d.siteId,d])),d=>d.day);
    yMax=Math.max(150,Math.ceil(d3.max(rows,d=>d.aqi)/50)*50);
    state={selected:defaultIds,start:MIN,end:M.dateMs('2025-03-31'),current:M.dateMs('2025-01-22'),playing:false,speed:600};
    wireControls();populateProvenance();renderAll();
  }
  init().catch(error=>{console.error(error);$('#load-error').hidden=false;$('#load-error').textContent=`資料載入失敗：${error.message}。請重新整理，或重新擷取專案完整資料。`;document.querySelectorAll('button,input,select').forEach(el=>el.disabled=true);});
})();
