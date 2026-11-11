/*
 * Pure data helpers
 * These help functions are shared by the browser and the Node verification script.
 */

(function(root) {
  'use strict';
  const DAY = 86400000;
  const dateKey = value => new Date(value).toISOString().slice(0, 10);
  const dateMs = value => Date.parse(`${value}T00:00:00Z`);
  function numberOrNull(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  function median(values) {
    const a = values.filter(Number.isFinite).sort((x,y) => x-y);
    if (!a.length) return null;
    const i = Math.floor(a.length/2);
    return a.length % 2 ? a[i] : (a[i-1]+a[i])/2;
  }
  function summarize(rows, start, end, stationIds) {
    const selected = new Set(stationIds);
    const filtered = rows.filter(d => selected.has(d.siteId) && d.day >= start && d.day <= end);
    const days = Math.round((end-start)/DAY)+1;
    const stations = stationIds.map(id => {
      const values = filtered.filter(d=>d.siteId===id).map(d=>d.aqi).filter(Number.isFinite);
      const above = values.filter(v=>v>100).length;
      return {id, valid:values.length, missing:days-values.length, days, median:median(values), above, ratio:values.length?above/values.length:null, max:values.length?Math.max(...values):null};
    });
    const valid = stations.reduce((s,d)=>s+d.valid,0);
    const above = stations.reduce((s,d)=>s+d.above,0);
    return {days, stations, valid, expected:days*stationIds.length, above, ratio:valid?above/valid:null, coverage:stationIds.length?valid/(days*stationIds.length):null};
  }
  function normalizeRows(rawRows) {
    const seen = new Set();
    return rawRows.map(d => {
      const day = dateMs(d.date), siteId = String(d.siteId);
      const key = `${siteId}/${d.date}`;
      if (!Number.isFinite(day) || dateKey(day)!==d.date) throw new Error(`日期格式錯誤：${d.date}`);
      if (seen.has(key)) throw new Error(`重複測站日期：${key}`);
      seen.add(key);
      return {date:d.date, day, siteId, siteName:d.siteName, aqi:numberOrNull(d.aqi)};
    }).sort((a,b)=>a.day-b.day || a.siteId.localeCompare(b.siteId));
  }
  const api = {DAY,dateKey,dateMs,numberOrNull,median,summarize,normalizeRows};
  root.AQIModel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
