import { Router } from 'express';
import { z } from 'zod';

import { getDb, now } from '../db/database.js';
import { requireAuth, requirePermission, userCan } from '../auth/middleware.js';
import { ah, parseQuery } from '../http/helpers.js';
import { round2, ratio } from '../core/money.js';
import { readSetting } from './config.js';

const DAY_MS = 86_400_000;

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

/* ================================================================== */
/* Shared helpers                                                      */
/* ================================================================== */

/** Positive finite number from a query string, or null when absent/junk. */
function numParam(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function strParam(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Empty conds → empty string, so no query ends up with a dangling `WHERE`. */
function where(conds: string[]): string {
  return conds.length ? `WHERE ${conds.join(' AND ')}` : '';
}

function round2OrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? round2(v) : null;
}

/* ================================================================== */
/* GET /funnel — the company-wide business funnel                      */
/* ================================================================== */

/**
 * Every step is a COUNT (or SUM) over real rows inside the window
 * [`from`, `to`] (epoch ms; `from` defaults to the beginning of time, `to`
 * to now). Filters only constrain the steps whose table carries that
 * column — each derivation is commented at its own step. Nothing here is
 * estimated or hard-coded.
 */
dashboardRouter.get(
  '/funnel',
  requirePermission('kpi.view'),
  ah(async (req, res) => {
    const q = req.query as any;
    const to = numParam(q.to) ?? now();
    const from = numParam(q.from) ?? 0;
    const repId = strParam(q.repId);
    const estimatorId = strParam(q.estimatorId);
    const closerId = strParam(q.closerId);
    const sourceId = strParam(q.sourceId);
    const territoryId = strParam(q.territoryId);
    const trade = strParam(q.trade);
    const projectStatus = strParam(q.projectStatus);

    const db = getDb();
    const scalar = (sql: string, ...p: any[]): any => db.prepare(sql).get(...p);
    const listOf = (sql: string, ...p: any[]): any[] => db.prepare(sql).all(...p);
    const countOf = (sql: string, ...p: any[]): number => Number(scalar(sql, ...p)?.n ?? 0);
    const sumOf = (sql: string, ...p: any[]): number => round2(scalar(sql, ...p)?.n ?? 0);

    // 1) dials — outbound calls logged inside the window.
    //    repId → communications.logged_by (the user who logged the call;
    //    communications has no owner column of its own).
    const cDial = ['cm.channel = ?', 'cm.direction = ?', 'cm.occurred_at >= ?', 'cm.occurred_at <= ?'];
    const pDial: any[] = ['call', 'outbound', from, to];
    if (repId) { cDial.push('cm.logged_by = ?'); pDial.push(repId); }
    const dials = countOf(`SELECT COUNT(*) AS n FROM communications cm ${where(cDial)}`, ...pDial);

    // 2) connects — the same outbound calls whose outcome was 'connected'.
    const connects = countOf(
      `SELECT COUNT(*) AS n FROM communications cm ${where([...cDial, "cm.outcome = 'connected'"])}`,
      ...pDial,
    );

    // 3) leads — ONE rule, chosen for reproducibility: a prospect CREATED in
    //    the window counts as a lead once it has left the raw 'prospect'
    //    stage OR has at least one logged contact (last_contact_at set).
    //    Both signals live on the prospect row, so the count is a pure
    //    function of stored data. Filters: repId → owner_id,
    //    sourceId → source_id, territoryId → territory_id.
    const cLead = [
      'p.created_at >= ?', 'p.created_at <= ?',
      "(p.stage <> 'prospect' OR p.last_contact_at IS NOT NULL)",
    ];
    const pLead: any[] = [from, to];
    if (repId) { cLead.push('p.owner_id = ?'); pLead.push(repId); }
    if (sourceId) { cLead.push('p.source_id = ?'); pLead.push(sourceId); }
    if (territoryId) { cLead.push('p.territory_id = ?'); pLead.push(territoryId); }
    const leads = countOf(`SELECT COUNT(*) AS n FROM prospects p ${where(cLead)}`, ...pLead);

    // 4) quote_requests — bids whose started_at falls in the window.
    //    estimatorId → bids.estimator_id, trade → bids.trade.
    const cBid = ['b.started_at >= ?', 'b.started_at <= ?'];
    const pBid: any[] = [from, to];
    if (estimatorId) { cBid.push('b.estimator_id = ?'); pBid.push(estimatorId); }
    if (trade) { cBid.push('b.trade = ?'); pBid.push(trade); }
    const quoteRequests = countOf(`SELECT COUNT(*) AS n FROM bids b ${where(cBid)}`, ...pBid);

    // 5) quotes_completed — estimates that reached 'released' or
    //    'pending_release' and were created in the window. Estimator and
    //    trade ride on the parent bid.
    const cEst = ["e.status IN ('released', 'pending_release')", 'e.created_at >= ?', 'e.created_at <= ?'];
    const pEst: any[] = [from, to];
    if (estimatorId) { cEst.push('b.estimator_id = ?'); pEst.push(estimatorId); }
    if (trade) { cEst.push('b.trade = ?'); pEst.push(trade); }
    const estWhere = where(cEst);
    const quotesCompleted = countOf(
      `SELECT COUNT(*) AS n FROM estimates e JOIN bids b ON b.id = e.bid_id ${estWhere}`,
      ...pEst,
    );
    // Dollar value: SUM of the server-computed calc.sellingPrice snapshot on
    // each estimate (parsed row by row). If no row carries a parseable
    // sellingPrice the value is null — never a guess. Zero rows → 0.
    let quotesCompletedValue: number | null = 0;
    if (quotesCompleted > 0) {
      const calcRows = listOf(
        `SELECT e.calc FROM estimates e JOIN bids b ON b.id = e.bid_id ${estWhere}`,
        ...pEst,
      );
      let sum = 0;
      let found = false;
      for (const r of calcRows) {
        try {
          const calc = JSON.parse(String(r.calc));
          if (calc && Number.isFinite(calc.sellingPrice)) {
            sum += calc.sellingPrice;
            found = true;
          }
        } catch {
          /* an unparseable calc contributes nothing */
        }
      }
      quotesCompletedValue = found ? round2(sum) : null;
    }

    // 6) quotes_submitted — proposals actually sent in the window.
    //    closerId → deals.closer_id, trade → deals.trade.
    const cProp = ['p.sent_at IS NOT NULL', 'p.sent_at >= ?', 'p.sent_at <= ?'];
    const pProp: any[] = [from, to];
    if (closerId) { cProp.push('d.closer_id = ?'); pProp.push(closerId); }
    if (trade) { cProp.push('d.trade = ?'); pProp.push(trade); }
    const quotesSubmitted = countOf(
      `SELECT COUNT(*) AS n FROM proposals p JOIN deals d ON d.id = p.deal_id ${where(cProp)}`,
      ...pProp,
    );

    // 7) negotiating — point-in-time snapshot: deals sitting in
    //    'negotiating' right now, regardless of the window.
    const cNeg = ["d.stage = 'negotiating'"];
    const pNeg: any[] = [];
    if (closerId) { cNeg.push('d.closer_id = ?'); pNeg.push(closerId); }
    if (trade) { cNeg.push('d.trade = ?'); pNeg.push(trade); }
    const negotiating = countOf(`SELECT COUNT(*) AS n FROM deals d ${where(cNeg)}`, ...pNeg);

    // 8) won — deals whose won_at falls in the window; value = SUM(d.value).
    const cWon = ["d.stage = 'won'", 'd.won_at >= ?', 'd.won_at <= ?'];
    const pWon: any[] = [from, to];
    if (closerId) { cWon.push('d.closer_id = ?'); pWon.push(closerId); }
    if (trade) { cWon.push('d.trade = ?'); pWon.push(trade); }
    const won = countOf(`SELECT COUNT(*) AS n FROM deals d ${where(cWon)}`, ...pWon);
    const wonValue = sumOf(`SELECT COALESCE(SUM(d.value), 0) AS n FROM deals d ${where(cWon)}`, ...pWon);

    // 9) lost — deals whose lost_at falls in the window.
    const cLost = ["d.stage = 'lost'", 'd.lost_at >= ?', 'd.lost_at <= ?'];
    const pLost: any[] = [from, to];
    if (closerId) { cLost.push('d.closer_id = ?'); pLost.push(closerId); }
    if (trade) { cLost.push('d.trade = ?'); pLost.push(trade); }
    const lost = countOf(`SELECT COUNT(*) AS n FROM deals d ${where(cLost)}`, ...pLost);

    // 10) production — projects created in the window.
    //     projectStatus → projects.status; trade → the project carries a job
    //     in that trade (projects have no trade column of their own).
    const cProj = ['pr.created_at >= ?', 'pr.created_at <= ?'];
    const pProj: any[] = [from, to];
    if (projectStatus) { cProj.push('pr.status = ?'); pProj.push(projectStatus); }
    if (trade) {
      cProj.push('EXISTS (SELECT 1 FROM jobs j WHERE j.project_id = pr.id AND j.trade = ?)');
      pProj.push(trade);
    }
    const production = countOf(`SELECT COUNT(*) AS n FROM projects pr ${where(cProj)}`, ...pProj);

    // 11) invoiced — non-void invoices issued in the window;
    //     value = SUM(invoices.amount).
    const cInv = ["i.status <> 'void'", 'i.issued_at >= ?', 'i.issued_at <= ?'];
    const pInv: any[] = [from, to];
    const invoiced = countOf(`SELECT COUNT(*) AS n FROM invoices i ${where(cInv)}`, ...pInv);
    const invoicedValue = sumOf(`SELECT COALESCE(SUM(i.amount), 0) AS n FROM invoices i ${where(cInv)}`, ...pInv);

    // 12) paid — invoices collected in the window (collected_at stamp);
    //     value = SUM(invoices.amount) of those invoices.
    const cPaid = ["i.status = 'paid'", 'i.collected_at >= ?', 'i.collected_at <= ?'];
    const pPaid: any[] = [from, to];
    const paid = countOf(`SELECT COUNT(*) AS n FROM invoices i ${where(cPaid)}`, ...pPaid);
    const paidValue = sumOf(`SELECT COALESCE(SUM(i.amount), 0) AS n FROM invoices i ${where(cPaid)}`, ...pPaid);

    const raw = [
      { key: 'dials', label: 'Dials', count: dials, value: null as number | null },
      { key: 'connects', label: 'Connects', count: connects, value: null as number | null },
      { key: 'leads', label: 'Leads', count: leads, value: null as number | null },
      { key: 'quote_requests', label: 'Quote Requests', count: quoteRequests, value: null as number | null },
      { key: 'quotes_completed', label: 'Quotes Completed', count: quotesCompleted, value: quotesCompletedValue },
      { key: 'quotes_submitted', label: 'Quotes Submitted', count: quotesSubmitted, value: null as number | null },
      { key: 'negotiating', label: 'Negotiating', count: negotiating, value: null as number | null },
      { key: 'won', label: 'Won', count: won, value: wonValue },
      { key: 'lost', label: 'Lost', count: lost, value: null as number | null },
      { key: 'production', label: 'Production', count: production, value: null as number | null },
      { key: 'invoiced', label: 'Invoiced', count: invoiced, value: invoicedValue },
      { key: 'paid', label: 'Paid', count: paid, value: paidValue },
    ];

    const steps = raw.map((step, i) => {
      // conversionFromPrevious = count / previous count; null when there is
      // no previous step or the previous count is 0.
      const prev = i === 0 ? null : raw[i - 1].count;
      const conversion = prev === null ? null : ratio(step.count, prev);
      return {
        ...step,
        conversionFromPrevious: conversion,
        conversionPct: conversion === null ? null : round2(conversion * 100),
      };
    });

    res.json({ steps });
  }),
);

/* ================================================================== */
/* GET /kpis — scope-shaped KPI reporting                              */
/* ================================================================== */

const kpiQuerySchema = z.object({
  scope: z.enum(['prospecting', 'underwriting', 'sales', 'production']),
  period: z.enum(['day', 'week', 'month']).default('month'),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  userId: z.string().trim().max(64).optional(),
});

const PERIOD_MS: Record<'day' | 'week' | 'month', number> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
};

dashboardRouter.get(
  '/kpis',
  // Route-level gate: foremen (and anyone else without kpi.view) get a 403
  // here before a single row is read.
  requirePermission('kpi.view'),
  ah(async (req, res) => {
    const q = parseQuery(kpiQuerySchema, req.query);
    const at = now();
    const to = q.to && q.to > 0 ? q.to : at;
    // Default window: the rolling day/week/month ending at `to`, unless the
    // caller passes explicit `from`/`to` bounds.
    const from = q.from && q.from > 0 ? q.from : to - PERIOD_MS[q.period ?? 'month'];

    const db = getDb();
    const scalar = (sql: string, ...p: any[]): any => db.prepare(sql).get(...p);
    const listOf = (sql: string, ...p: any[]): any[] => db.prepare(sql).all(...p);
    const countOf = (sql: string, ...p: any[]): number => Number(scalar(sql, ...p)?.n ?? 0);

    /* ------------------------------ prospecting ------------------------------ */

    if (q.scope === 'prospecting') {
      // userId → prospect owner / call logger / task assignee.
      const cDial = ['cm.channel = ?', 'cm.direction = ?', 'cm.occurred_at >= ?', 'cm.occurred_at <= ?'];
      const pDial: any[] = ['call', 'outbound', from, to];
      if (q.userId) { cDial.push('cm.logged_by = ?'); pDial.push(q.userId); }
      const outboundDials = countOf(`SELECT COUNT(*) AS n FROM communications cm ${where(cDial)}`, ...pDial);
      const connectedCalls = countOf(
        `SELECT COUNT(*) AS n FROM communications cm ${where([...cDial, "cm.outcome = 'connected'"])}`,
        ...pDial,
      );

      // Same lead rule as the funnel: created in the window AND (left the
      // raw 'prospect' stage OR has a logged contact).
      const cLead = [
        'p.created_at >= ?', 'p.created_at <= ?',
        "(p.stage <> 'prospect' OR p.last_contact_at IS NOT NULL)",
      ];
      const pLead: any[] = [from, to];
      if (q.userId) { cLead.push('p.owner_id = ?'); pLead.push(q.userId); }
      const leadWhere = where(cLead);
      const leadsGenerated = countOf(`SELECT COUNT(*) AS n FROM prospects p ${leadWhere}`, ...pLead);

      const cDone = ['t.status = ?', 't.completed_at >= ?', 't.completed_at <= ?'];
      const pDone: any[] = ['done', from, to];
      if (q.userId) { cDone.push('t.assignee_id = ?'); pDone.push(q.userId); }
      const followUpsCompleted = countOf(`SELECT COUNT(*) AS n FROM tasks t ${where(cDone)}`, ...pDone);

      // Overdue = still open with a due date in the past (point in time).
      const cOver = ['t.status = ?', 't.due_at < ?'];
      const pOver: any[] = ['open', at];
      if (q.userId) { cOver.push('t.assignee_id = ?'); pOver.push(q.userId); }
      const followUpsOverdue = countOf(`SELECT COUNT(*) AS n FROM tasks t ${where(cOver)}`, ...pOver);

      const leadsBySource = listOf(
        `SELECT COALESCE(s.name, 'Unknown source') AS name, COUNT(*) AS count
           FROM prospects p LEFT JOIN lead_sources s ON s.id = p.source_id
          ${leadWhere} GROUP BY p.source_id ORDER BY count DESC, name COLLATE NOCASE`,
        ...pLead,
      );

      const leadsByTerritory = listOf(
        `SELECT COALESCE(t.name, 'Unknown territory') AS name, COUNT(*) AS count
           FROM prospects p LEFT JOIN territories t ON t.id = p.territory_id
          ${leadWhere} GROUP BY p.territory_id ORDER BY count DESC, name COLLATE NOCASE`,
        ...pLead,
      );

      // A converted lead is one that has at least one bid on file.
      const leadsConvertedToQuoteRequests = countOf(
        `SELECT COUNT(*) AS n FROM prospects p
          WHERE ${[...cLead, 'EXISTS (SELECT 1 FROM bids b WHERE b.prospect_id = p.id)'].join(' AND ')}`,
        ...pLead,
      );

      // Stage mix over ALL prospects created in the window (not just leads),
      // so the percentages describe the whole cohort and sum to 100.
      const cStage = ['p.created_at >= ?', 'p.created_at <= ?'];
      const pStage: any[] = [from, to];
      if (q.userId) { cStage.push('p.owner_id = ?'); pStage.push(q.userId); }
      const stageRows = listOf(
        `SELECT p.stage AS stage, COUNT(*) AS count FROM prospects p
          WHERE ${cStage.join(' AND ')} GROUP BY p.stage ORDER BY count DESC`,
        ...pStage,
      );
      const stageTotal = stageRows.reduce((a: number, r: any) => a + Number(r.count ?? 0), 0);
      const conversionRateByStage = stageRows.map((r: any) => ({
        stage: r.stage,
        count: r.count,
        pct: stageTotal > 0 ? round2((Number(r.count) / stageTotal) * 100) : 0,
      }));

      res.json({
        outboundDials,
        connectedCalls,
        leadsGenerated,
        callsPerLead: ratio(outboundDials, leadsGenerated),
        followUpsCompleted,
        followUpsOverdue,
        leadsBySource,
        leadsByTerritory,
        leadsConvertedToQuoteRequests,
        conversionRateByStage,
      });
      return;
    }

    /* ----------------------------- underwriting ----------------------------- */

    if (q.scope === 'underwriting') {
      // userId → bids.estimator_id; estimates and approvals inherit it
      // through their bid.
      const cBids = ['b.started_at >= ?', 'b.started_at <= ?'];
      const pBids: any[] = [from, to];
      if (q.userId) { cBids.push('b.estimator_id = ?'); pBids.push(q.userId); }
      const bidsReceived = countOf(`SELECT COUNT(*) AS n FROM bids b ${where(cBids)}`, ...pBids);

      const cQc = ["e.status IN ('released', 'pending_release')", 'e.created_at >= ?', 'e.created_at <= ?'];
      const pQc: any[] = [from, to];
      if (q.userId) { cQc.push('b.estimator_id = ?'); pQc.push(q.userId); }
      const qcWhere = where(cQc);
      const quotesCompleted = countOf(
        `SELECT COUNT(*) AS n FROM estimates e JOIN bids b ON b.id = e.bid_id ${qcWhere}`,
        ...pQc,
      );

      // Turnaround: AVG(released_at − bids.started_at) in hours over
      // estimates RELEASED inside the window (null when none were released).
      const cTurn = ["e.status = 'released'", 'e.released_at >= ?', 'e.released_at <= ?', 'b.started_at IS NOT NULL'];
      const pTurn: any[] = [from, to];
      if (q.userId) { cTurn.push('b.estimator_id = ?'); pTurn.push(q.userId); }
      const averageTurnaroundHours = round2OrNull(
        scalar(
          `SELECT AVG((e.released_at - b.started_at) / 3600000.0) AS v
             FROM estimates e JOIN bids b ON b.id = e.bid_id
            WHERE ${cTurn.join(' AND ')}`,
          ...pTurn,
        )?.v,
      );

      // Average age of OPEN bids (started, not yet released, not archived) —
      // point in time, because age is measured against now, not the window.
      const cAge = ['b.archived_at IS NULL', 'b.released_at IS NULL', 'b.started_at IS NOT NULL'];
      const pAge: any[] = [];
      if (q.userId) { cAge.push('b.estimator_id = ?'); pAge.push(q.userId); }
      const averageBidAgeDays = round2OrNull(
        scalar(
          `SELECT AVG((? - b.started_at) / 86400000.0) AS v FROM bids b WHERE ${cAge.join(' AND ')}`,
          at,
          ...pAge,
        )?.v,
      );

      // Overdue = quote_due_at in the past with no release yet (point in time).
      const cOd = ['b.archived_at IS NULL', 'b.released_at IS NULL', 'b.quote_due_at IS NOT NULL', 'b.quote_due_at < ?'];
      const pOd: any[] = [at];
      if (q.userId) { cOd.push('b.estimator_id = ?'); pOd.push(q.userId); }
      const overdueBids = countOf(`SELECT COUNT(*) AS n FROM bids b ${where(cOd)}`, ...pOd);

      const quotesByEstimator = listOf(
        `SELECT COALESCE(u.name, 'Unassigned') AS name, COUNT(*) AS count
           FROM estimates e JOIN bids b ON b.id = e.bid_id
           LEFT JOIN users u ON u.id = b.estimator_id
          ${qcWhere} GROUP BY b.estimator_id ORDER BY count DESC, name COLLATE NOCASE`,
        ...pQc,
      );

      // Revisions = estimates beyond version 1 (created in the window).
      const cRev = ['e.version > 1', 'e.created_at >= ?', 'e.created_at <= ?'];
      const pRev: any[] = [from, to];
      if (q.userId) { cRev.push('b.estimator_id = ?'); pRev.push(q.userId); }
      const revisions = countOf(
        `SELECT COUNT(*) AS n FROM estimates e JOIN bids b ON b.id = e.bid_id ${where(cRev)}`,
        ...pRev,
      );

      // Margin exceptions: approvals DECIDED in the window (falling back to
      // the request stamp when decided_at is somehow absent).
      const cMa = [
        "ma.status = 'approved'",
        'COALESCE(ma.decided_at, ma.requested_at) >= ?',
        'COALESCE(ma.decided_at, ma.requested_at) <= ?',
      ];
      const pMa: any[] = [from, to];
      if (q.userId) { cMa.push('b.estimator_id = ?'); pMa.push(q.userId); }
      const marginExceptions = countOf(
        `SELECT COUNT(*) AS n FROM margin_approvals ma JOIN bids b ON b.id = ma.bid_id
          WHERE ${cMa.join(' AND ')}`,
        ...pMa,
      );

      res.json({
        bidsReceived,
        quotesCompleted,
        leadToQuoteConversion: ratio(quotesCompleted, bidsReceived),
        averageTurnaroundHours,
        averageBidAgeDays,
        overdueBids,
        quotesByEstimator,
        revisions,
        marginExceptions,
      });
      return;
    }

    /* -------------------------------- sales -------------------------------- */

    if (q.scope === 'sales') {
      // userId → deals.closer_id; proposals and contracts reach it via deal.
      const cProp = ['p.sent_at IS NOT NULL', 'p.sent_at >= ?', 'p.sent_at <= ?'];
      const pProp: any[] = [from, to];
      if (q.userId) { cProp.push('d.closer_id = ?'); pProp.push(q.userId); }
      const propWhere = where(cProp);
      const quotesSubmittedCount = countOf(
        `SELECT COUNT(*) AS n FROM proposals p JOIN deals d ON d.id = p.deal_id ${propWhere}`,
        ...pProp,
      );
      const quotesSubmittedValue = round2(
        scalar(
          `SELECT COALESCE(SUM(p.total), 0) AS n FROM proposals p JOIN deals d ON d.id = p.deal_id ${propWhere}`,
          ...pProp,
        )?.n ?? 0,
      );

      const byDeliveryMethod = listOf(
        `SELECT COALESCE(NULLIF(p.delivery_method, ''), 'not_specified') AS method, COUNT(*) AS count
           FROM proposals p JOIN deals d ON d.id = p.deal_id
          ${propWhere} GROUP BY method ORDER BY count DESC, method COLLATE NOCASE`,
        ...pProp,
      );

      // Point-in-time: deals currently negotiating (window ignored).
      const cNeg = ["d.stage = 'negotiating'"];
      const pNeg: any[] = [];
      if (q.userId) { cNeg.push('d.closer_id = ?'); pNeg.push(q.userId); }
      const negotiating = countOf(`SELECT COUNT(*) AS n FROM deals d ${where(cNeg)}`, ...pNeg);

      // Contracts actually SENT in the window; void contracts never count.
      const cCon = ['c.sent_at IS NOT NULL', 'c.sent_at >= ?', 'c.sent_at <= ?', "c.status <> 'void'"];
      const pCon: any[] = [from, to];
      if (q.userId) { cCon.push('d.closer_id = ?'); pCon.push(q.userId); }
      const contractsSent = countOf(
        `SELECT COUNT(*) AS n FROM contracts c JOIN deals d ON d.id = c.deal_id ${where(cCon)}`,
        ...pCon,
      );

      const cWon = ["d.stage = 'won'", 'd.won_at >= ?', 'd.won_at <= ?'];
      const pWon: any[] = [from, to];
      if (q.userId) { cWon.push('d.closer_id = ?'); pWon.push(q.userId); }
      const wonWhere = where(cWon);
      const won = countOf(`SELECT COUNT(*) AS n FROM deals d ${wonWhere}`, ...pWon);
      // Average value / days-to-close of the deals WON inside the window
      // (null when none were won).
      const averageDealValue = round2OrNull(scalar(`SELECT AVG(d.value) AS v FROM deals d ${wonWhere}`, ...pWon)?.v);
      const avgDaysToClose = round2OrNull(
        scalar(
          `SELECT AVG((d.won_at - d.created_at) / 86400000.0) AS v FROM deals d ${wonWhere}`,
          ...pWon,
        )?.v,
      );

      const cLost = ["d.stage = 'lost'", 'd.lost_at >= ?', 'd.lost_at <= ?'];
      const pLost: any[] = [from, to];
      if (q.userId) { cLost.push('d.closer_id = ?'); pLost.push(q.userId); }
      const lostWhere = where(cLost);
      const lost = countOf(`SELECT COUNT(*) AS n FROM deals d ${lostWhere}`, ...pLost);

      const lostReasons = listOf(
        `SELECT COALESCE(NULLIF(d.lost_reason, ''), 'Not recorded') AS reason, COUNT(*) AS count
           FROM deals d ${lostWhere} GROUP BY reason ORDER BY count DESC`,
        ...pLost,
      );

      // Stage durations are only reconstructable from audit rows (action
      // 'deal.stage*', same convention as job.stage_changed). Each stage
      // change lasts until that deal's next stage change; durations that
      // START inside the window are averaged per stage. When the trail holds
      // no such rows the honest answer is [] — we never fake it.
      const stageEvents = listOf(
        `SELECT entity_id, at, after FROM audit_events
          WHERE entity_type = 'deal' AND action LIKE 'deal.stage%' AND at <= ?
          ORDER BY entity_id ASC, at ASC`,
        to,
      );
      const stageSums = new Map<string, { total: number; n: number }>();
      let prev: { id: string; at: number; stage: string | null } | null = null;
      for (const ev of stageEvents) {
        let stage: string | null = null;
        if (typeof ev.after === 'string' && ev.after) {
          try {
            const parsed = JSON.parse(ev.after);
            if (parsed && typeof parsed.stage === 'string') stage = parsed.stage;
          } catch {
            /* unparseable audit payload — this event contributes nothing */
          }
        }
        if (prev && prev.id === ev.entity_id && prev.stage && ev.at >= prev.at && prev.at >= from) {
          const bucket = stageSums.get(prev.stage) ?? { total: 0, n: 0 };
          bucket.total += ev.at - prev.at;
          bucket.n += 1;
          stageSums.set(prev.stage, bucket);
        }
        prev = { id: ev.entity_id, at: Number(ev.at), stage };
      }
      const timeInStage = [...stageSums.entries()]
        .map(([stage, b]) => ({ stage, avgDays: round2(b.total / b.n / DAY_MS) }))
        .sort((a, b) => b.avgDays - a.avgDays);

      res.json({
        quotesSubmittedCount,
        quotesSubmittedValue,
        byDeliveryMethod,
        negotiating,
        contractsSent,
        won,
        lost,
        closeRate: ratio(won, won + lost),
        averageDealValue,
        timeInStage,
        lostReasons,
        avgDaysToClose,
      });
      return;
    }

    /* ------------------------------- production ------------------------------ */

    // userId → jobs.foreman_id / task assignee / report foreman. Project-level
    // money rollups stay company-wide: costs, draws and change orders are
    // recorded against the PROJECT, not a foreman, so filtering them by user
    // would produce a number that belongs to nobody.
    const userCond = q.userId ? ' AND j.foreman_id = ?' : '';
    const userParams: any[] = q.userId ? [q.userId] : [];

    const jobsStarted = countOf(
      `SELECT COUNT(*) AS n FROM jobs j WHERE j.started_at >= ? AND j.started_at <= ?${userCond}`,
      from, to, ...userParams,
    );
    const jobsCompleted = countOf(
      `SELECT COUNT(*) AS n FROM jobs j WHERE j.completed_at >= ? AND j.completed_at <= ?${userCond}`,
      from, to, ...userParams,
    );

    // Stage aging can only be measured for the CURRENT stage: the schema
    // keeps a single stage_entered_at stamp and has no stage-history table,
    // so durations of stages a job already left are not recoverable from
    // rows. This is time-in-current-stage, honestly labelled.
    const stageAging = listOf(
      `SELECT j.stage AS stage, AVG((? - j.stage_entered_at) / 86400000.0) AS avg_days
         FROM jobs j WHERE j.stage_entered_at IS NOT NULL${userCond}
        GROUP BY j.stage ORDER BY avg_days DESC`,
      at, ...userParams,
    );
    const avgDaysPerStage = stageAging.map((r: any) => ({
      stage: r.stage,
      avgDays: round2OrNull(r.avg_days) ?? 0,
    }));

    // Adherence: of the jobs COMPLETED in the window, the percentage that
    // finished on or before their scheduled end. A job never given a
    // scheduled_end cannot be judged and leaves the denominator; with nobody
    // to judge the metric is null, never a made-up 100%.
    const adherence = scalar(
      `SELECT COUNT(*) AS completed,
              SUM(CASE WHEN j.scheduled_end IS NOT NULL AND j.completed_at <= j.scheduled_end THEN 1 ELSE 0 END) AS on_time,
              SUM(CASE WHEN j.scheduled_end IS NOT NULL THEN 1 ELSE 0 END) AS judged
         FROM jobs j WHERE j.completed_at >= ? AND j.completed_at <= ?${userCond}`,
      from, to, ...userParams,
    );
    const scheduleAdherence =
      adherence && Number(adherence.judged ?? 0) > 0
        ? round2((Number(adherence.on_time ?? 0) / Number(adherence.judged)) * 100)
        : null;

    // Estimated vs actual: point-in-time rollup. Cost accrues against the
    // whole job, so windowing job_costs would understate work already paid
    // for outside the window. variance = estimated − actual (positive = under
    // budget); variancePct is null when nothing was estimated.
    const estimated = round2(
      scalar('SELECT COALESCE(SUM(estimated_cost), 0) AS n FROM jobs')?.n ?? 0,
    );
    const actual = round2(
      scalar(`SELECT COALESCE(SUM(amount), 0) AS n FROM job_costs WHERE kind = 'actual'`)?.n ?? 0,
    );
    const variance = round2(estimated - actual);
    const varianceRatio = ratio(variance, estimated);
    const estimatedVsActual = {
      estimated,
      actual,
      variance,
      variancePct: varianceRatio === null ? null : round2(varianceRatio * 100),
    };

    // Change orders: requested/approved are windowed by the REQUEST date (the
    // decision stamp differs per status, so the request cohort is the only
    // window both share); authorized uses its own authorized_at stamp.
    const coRequested = countOf(
      `SELECT COUNT(*) AS n FROM change_orders co WHERE co.requested_at >= ? AND co.requested_at <= ?`,
      from, to,
    );
    const coApproved = countOf(
      `SELECT COUNT(*) AS n FROM change_orders co
        WHERE co.status IN ('internal_approved', 'customer_approved', 'authorized')
          AND co.requested_at >= ? AND co.requested_at <= ?`,
      from, to,
    );
    const cCoAuth = ["co.status = 'authorized'", 'co.authorized_at >= ?', 'co.authorized_at <= ?'];
    const coAuthorized = countOf(`SELECT COUNT(*) AS n FROM change_orders co ${where(cCoAuth)}`, from, to);
    const coValue = round2(
      scalar(`SELECT COALESCE(SUM(co.customer_amount), 0) AS n FROM change_orders co ${where(cCoAuth)}`, from, to)?.n ?? 0,
    );
    const changeOrders = {
      requested: coRequested,
      approved: coApproved,
      authorized: coAuthorized,
      value: coValue,
    };

    const drawsBilled = round2(
      scalar(
        `SELECT COALESCE(SUM(i.amount), 0) AS n FROM invoices i
          WHERE i.status <> 'void' AND i.issued_at >= ? AND i.issued_at <= ?`,
        from, to,
      )?.n ?? 0,
    );
    const drawsCollected = round2(
      scalar(
        `SELECT COALESCE(SUM(pm.amount), 0) AS n FROM payments pm
          WHERE pm.received_at >= ? AND pm.received_at <= ?`,
        from, to,
      )?.n ?? 0,
    );
    // Outstanding receivables is a balance, so it is point-in-time by nature.
    const outstandingReceivables = round2(
      scalar(
        `SELECT (SELECT COALESCE(SUM(amount), 0) FROM invoices WHERE status <> 'void')
              - (SELECT COALESCE(SUM(amount), 0) FROM payments) AS n`,
      )?.n ?? 0,
    );

    // Counted by the day the report COVERS (report_date), not when it was
    // typed; userId → the report's foreman.
    const cDr = [
      "dr.status IN ('submitted', 'approved')",
      'dr.report_date >= ?', 'dr.report_date <= ?',
    ];
    const pDr: any[] = [from, to];
    if (q.userId) { cDr.push('dr.foreman_id = ?'); pDr.push(q.userId); }
    const dailyReportsSubmitted = countOf(
      `SELECT COUNT(*) AS n FROM daily_reports dr WHERE ${cDr.join(' AND ')}`,
      ...pDr,
    );

    // Open blockers = open priority-1 tasks (the same rule the job-advance
    // gate uses); userId → the task's assignee.
    const cBlk = ['t.status = ?', 't.priority = ?'];
    const pBlk: any[] = ['open', 1];
    if (q.userId) { cBlk.push('t.assignee_id = ?'); pBlk.push(q.userId); }
    const openBlockers = countOf(`SELECT COUNT(*) AS n FROM tasks t WHERE ${cBlk.join(' AND ')}`, ...pBlk);

    // Cost overruns: projects whose recorded ACTUAL costs exceed the sum of
    // their jobs' estimated cost. estimated > 0 keeps projects that were
    // never estimated from counting as "overruns" of zero.
    const costOverruns = countOf(
      `SELECT COUNT(*) AS n FROM projects pr
        WHERE (SELECT COALESCE(SUM(jc.amount), 0) FROM job_costs jc
                WHERE jc.project_id = pr.id AND jc.kind = 'actual')
            > (SELECT COALESCE(SUM(j.estimated_cost), 0) FROM jobs j WHERE j.project_id = pr.id)
          AND (SELECT COALESCE(SUM(j2.estimated_cost), 0) FROM jobs j2 WHERE j2.project_id = pr.id) > 0`,
    );

    // Money gate: without production.financials the dollar figures never
    // leave this endpoint — counts stay, dollars become null.
    const canSeeMoney = userCan(req, 'production.financials');
    const payload: Record<string, unknown> = {
      jobsStarted,
      jobsCompleted,
      avgDaysPerStage,
      scheduleAdherence,
      estimatedVsActual,
      changeOrders,
      drawsBilled,
      drawsCollected,
      outstandingReceivables,
      dailyReportsSubmitted,
      openBlockers,
      costOverruns,
      financialsRestricted: !canSeeMoney,
    };
    if (!canSeeMoney) {
      payload.estimatedVsActual = null;
      payload.changeOrders = { ...changeOrders, value: null };
      payload.drawsBilled = null;
      payload.drawsCollected = null;
      payload.outstandingReceivables = null;
    }
    res.json(payload);
  }),
);

/* ================================================================== */
/* GET /today — daily operational dashboard                            */
/* ================================================================== */

interface AttentionItem {
  severity: 'critical' | 'warning' | 'info';
  kind: string;
  title: string;
  detail: string;
  link: string;
  entityType: string;
  entityId: string;
  /** Sort key only (the entity's own date); stripped before responding. */
  at: number;
}

dashboardRouter.get(
  '/today',
  ah(async (req, res) => {
    const db = getDb();
    const at = now();
    const todayStart = Math.floor(at / DAY_MS) * DAY_MS; // UTC day boundaries
    const tomorrowStart = todayStart + DAY_MS;
    const canSeeMoney = userCan(req, 'production.financials');

    // runningToday: jobs in progress right now, plus jobs scheduled to start
    // on today's UTC date.
    const runningToday = db
      .prepare(
        `SELECT j.id, j.job_no, j.name, j.trade, j.stage, j.scheduled_start, p.name AS project_name
           FROM jobs j JOIN projects p ON p.id = j.project_id
          WHERE j.stage = 'in_progress'
             OR (j.stage = 'scheduled' AND j.scheduled_start >= ? AND j.scheduled_start < ?)
          ORDER BY j.scheduled_start ASC NULLS FIRST, j.job_no`,
      )
      .all(todayStart, tomorrowStart);

    const scheduledTomorrow = db
      .prepare(
        `SELECT j.id, j.job_no, j.name, j.trade, j.stage, j.scheduled_start, p.name AS project_name
           FROM jobs j JOIN projects p ON p.id = j.project_id
          WHERE j.stage = 'scheduled' AND j.scheduled_start >= ? AND j.scheduled_start < ?
          ORDER BY j.scheduled_start ASC, j.job_no`,
      )
      .all(tomorrowStart, tomorrowStart + DAY_MS);

    // On-hold rule: a scheduled/in-progress job that has an OPEN
    // high-priority (priority = 1) task on the job or its project — a
    // recorded blocker. A pure staleness rule would invent a signal the data
    // does not contain, so we only surface blockers we can point at.
    const onHold = db
      .prepare(
        `SELECT j.id, j.job_no, j.name, j.trade, j.stage, j.scheduled_start, p.name AS project_name,
                (SELECT COUNT(*) FROM tasks t
                  WHERE t.status = 'open' AND t.priority = 1
                    AND (t.job_id = j.id OR t.project_id = j.project_id)) AS blockers
           FROM jobs j JOIN projects p ON p.id = j.project_id
          WHERE j.stage IN ('scheduled', 'in_progress')
            AND EXISTS (SELECT 1 FROM tasks t
                         WHERE t.status = 'open' AND t.priority = 1
                           AND (t.job_id = j.id OR t.project_id = j.project_id))
          ORDER BY j.scheduled_start ASC NULLS FIRST, j.job_no`,
      )
      .all();

    const reportsToday = db
      .prepare(
        `SELECT dr.id, dr.job_id, dr.report_date, dr.status, dr.submitted_at,
                j.job_no, j.trade, j.name AS job_name
           FROM daily_reports dr JOIN jobs j ON j.id = dr.job_id
          WHERE dr.report_date >= ? AND dr.report_date < ?
          ORDER BY dr.status, j.job_no`,
      )
      .all(todayStart, tomorrowStart);

    // A job owes today's report while it is in progress and no report row
    // exists for today (UNIQUE(job_id, report_date) makes the check exact).
    const owingJobs = db
      .prepare(
        `SELECT j.id, j.job_no, j.name, j.trade, p.name AS project_name
           FROM jobs j JOIN projects p ON p.id = j.project_id
          WHERE j.stage = 'in_progress'
            AND NOT EXISTS (SELECT 1 FROM daily_reports dr
                             WHERE dr.job_id = j.id AND dr.report_date >= ? AND dr.report_date < ?)
          ORDER BY j.job_no`,
      )
      .all(todayStart, tomorrowStart);

    const items: AttentionItem[] = [];

    // Overdue invoices — critical. The balance is money, so callers without
    // production.financials get the same alert with a non-financial detail.
    const overdueInvoices = db
      .prepare(
        `SELECT i.id, i.invoice_no, i.due_at, p.name AS project_name,
                i.amount - COALESCE((SELECT SUM(pm.amount) FROM payments pm WHERE pm.invoice_id = i.id), 0) AS balance
           FROM invoices i JOIN projects p ON p.id = i.project_id
          WHERE i.status IN ('sent', 'partial') AND i.due_at IS NOT NULL AND i.due_at < ?
          ORDER BY i.due_at ASC`,
      )
      .all(at) as any[];
    for (const inv of overdueInvoices) {
      const due = new Date(Number(inv.due_at)).toISOString().slice(0, 10);
      items.push({
        severity: 'critical',
        kind: 'invoice_overdue',
        title: `Invoice ${inv.invoice_no} is past due`,
        detail: canSeeMoney
          ? `Balance $${round2(inv.balance)} was due ${due} (${inv.project_name}).`
          : `Payment was due ${due} (${inv.project_name}).`,
        link: `/invoices/${inv.id}`,
        entityType: 'invoice',
        entityId: String(inv.id),
        at: Number(inv.due_at),
      });
    }

    // Cost overruns — critical. Dollar figures only for production.financials.
    const overruns = db
      .prepare(
        `SELECT pr.id, pr.project_no, pr.name, pr.updated_at,
                (SELECT COALESCE(SUM(jc.amount), 0) FROM job_costs jc
                  WHERE jc.project_id = pr.id AND jc.kind = 'actual') AS actual,
                (SELECT COALESCE(SUM(j.estimated_cost), 0) FROM jobs j
                  WHERE j.project_id = pr.id) AS estimated
           FROM projects pr
          WHERE (SELECT COALESCE(SUM(jc.amount), 0) FROM job_costs jc
                  WHERE jc.project_id = pr.id AND jc.kind = 'actual')
              > (SELECT COALESCE(SUM(j.estimated_cost), 0) FROM jobs j WHERE j.project_id = pr.id)
            AND (SELECT COALESCE(SUM(j2.estimated_cost), 0) FROM jobs j2 WHERE j2.project_id = pr.id) > 0
          ORDER BY pr.updated_at ASC`,
      )
      .all() as any[];
    for (const pr of overruns) {
      items.push({
        severity: 'critical',
        kind: 'cost_overrun',
        title: `Project ${pr.project_no} is over its estimated cost`,
        detail: canSeeMoney
          ? `Actual $${round2(pr.actual)} exceeds the estimate of $${round2(pr.estimated)} (${pr.name}).`
          : `Recorded costs have passed the estimated cost (${pr.name}).`,
        link: `/projects/${pr.id}`,
        entityType: 'project',
        entityId: String(pr.id),
        at: Number(pr.updated_at ?? at),
      });
    }

    /* ---------------------------- warnings ---------------------------- */

    // Jobs stuck in one stage for more than 14 days. 'paid' is terminal —
    // sitting there is not a stall.
    const STUCK_DAYS = 14;
    const stuckJobs = db
      .prepare(
        `SELECT j.id, j.job_no, j.stage, j.stage_entered_at, p.name AS project_name
           FROM jobs j JOIN projects p ON p.id = j.project_id
          WHERE j.stage_entered_at IS NOT NULL AND j.stage_entered_at < ? AND j.stage <> 'paid'
          ORDER BY j.stage_entered_at ASC`,
      )
      .all(at - STUCK_DAYS * DAY_MS) as any[];
    for (const j of stuckJobs) {
      const days = Math.floor((at - Number(j.stage_entered_at)) / DAY_MS);
      items.push({
        severity: 'warning',
        kind: 'job_stuck',
        title: `Job ${j.job_no} is stuck in ${j.stage}`,
        detail: `No stage change for ${days} days (${j.project_name}).`,
        link: `/jobs/${j.id}`,
        entityType: 'job',
        entityId: String(j.id),
        at: Number(j.stage_entered_at),
      });
    }

    // Jobs carrying open priority-1 tasks (blockers).
    const blockedJobs = db
      .prepare(
        `SELECT j.id, j.job_no, j.stage, COUNT(*) AS blockers, MIN(t.due_at) AS oldest_due
           FROM jobs j JOIN tasks t ON t.job_id = j.id
          WHERE t.status = 'open' AND t.priority = 1
          GROUP BY j.id ORDER BY oldest_due ASC`,
      )
      .all() as any[];
    for (const j of blockedJobs) {
      items.push({
        severity: 'warning',
        kind: 'job_blocker',
        title: `Job ${j.job_no} has ${j.blockers} open blocker${Number(j.blockers) === 1 ? '' : 's'}`,
        detail: `High-priority task${Number(j.blockers) === 1 ? '' : 's'} must close before ${j.stage} work can advance.`,
        link: `/jobs/${j.id}`,
        entityType: 'job',
        entityId: String(j.id),
        at: Number(j.oldest_due ?? at),
      });
    }

    // Bids past their quote due date with no release yet.
    const overdueBids = db
      .prepare(
        `SELECT b.id, b.bid_no, b.trade, b.quote_due_at
           FROM bids b
          WHERE b.archived_at IS NULL AND b.released_at IS NULL
            AND b.quote_due_at IS NOT NULL AND b.quote_due_at < ?
          ORDER BY b.quote_due_at ASC`,
      )
      .all(at) as any[];
    for (const b of overdueBids) {
      const due = new Date(Number(b.quote_due_at)).toISOString().slice(0, 10);
      items.push({
        severity: 'warning',
        kind: 'bid_overdue',
        title: `Bid ${b.bid_no} quote is overdue`,
        detail: `The quote was due ${due} (${b.trade}).`,
        link: `/bids/${b.id}`,
        entityType: 'bid',
        entityId: String(b.id),
        at: Number(b.quote_due_at),
      });
    }

    // Deals waiting for a signature for more than 7 days. Deals carry no
    // stage_entered_at column, so updated_at is the best available proxy
    // for when the deal last moved.
    const WAITING_DAYS = 7;
    const waitingDeals = db
      .prepare(
        `SELECT d.id, d.deal_no, d.project_name, d.updated_at
           FROM deals d
          WHERE d.archived_at IS NULL AND d.stage = 'waiting_to_sign' AND d.updated_at < ?
          ORDER BY d.updated_at ASC`,
      )
      .all(at - WAITING_DAYS * DAY_MS) as any[];
    for (const d of waitingDeals) {
      const days = Math.floor((at - Number(d.updated_at)) / DAY_MS);
      items.push({
        severity: 'warning',
        kind: 'deal_waiting_to_sign',
        title: `${d.deal_no} has been waiting to sign for ${days} days`,
        detail: `${d.project_name} has had no activity since ${new Date(Number(d.updated_at)).toISOString().slice(0, 10)}.`,
        link: `/deals/${d.id}`,
        entityType: 'deal',
        entityId: String(d.id),
        at: Number(d.updated_at),
      });
    }

    // In-progress jobs with no daily report filed for today.
    for (const j of owingJobs as any[]) {
      items.push({
        severity: 'warning',
        kind: 'missing_daily_report',
        title: `Job ${j.job_no} has no daily report for today`,
        detail: `Field report still outstanding (${j.project_name}).`,
        link: `/jobs/${j.id}`,
        entityType: 'job',
        entityId: String(j.id),
        at: at,
      });
    }

    // Pending margin approvals — only surfaced to callers who can actually
    // decide them.
    if (userCan(req, 'margin.approve_exception')) {
      const pending = db
        .prepare(
          `SELECT ma.id, ma.estimate_id, ma.requested_margin, ma.floor_margin, ma.requested_at, b.bid_no
             FROM margin_approvals ma JOIN bids b ON b.id = ma.bid_id
            WHERE ma.status = 'pending'
            ORDER BY ma.requested_at ASC`,
        )
        .all() as any[];
      for (const ma of pending) {
        items.push({
          severity: 'warning',
          kind: 'margin_approval_pending',
          title: `Margin exception awaiting approval — bid ${ma.bid_no}`,
          detail: `${round2(ma.requested_margin)}% requested against a ${round2(ma.floor_margin)}% floor.`,
          link: `/estimates/${ma.estimate_id}`,
          entityType: 'margin_approval',
          entityId: String(ma.id),
          at: Number(ma.requested_at),
        });
      }
    }

    /* ------------------------------ follow-ups ------------------------------ */

    // Overdue prospect follow-ups — informational (a rep's own queue item).
    const dueFollowups = db
      .prepare(
        `SELECT p.id, p.next_followup_at, p.stage, c.first_name, c.last_name
           FROM prospects p JOIN contacts c ON c.id = p.contact_id
          WHERE p.archived_at IS NULL AND p.next_followup_at IS NOT NULL AND p.next_followup_at < ?
          ORDER BY p.next_followup_at ASC`,
      )
      .all(at) as any[];
    for (const p of dueFollowups) {
      const due = new Date(Number(p.next_followup_at)).toISOString().slice(0, 10);
      items.push({
        severity: 'info',
        kind: 'followup_overdue',
        title: `Follow-up overdue for ${p.first_name} ${p.last_name}`.trim(),
        detail: `Next follow-up was due ${due} (stage: ${p.stage}).`,
        link: `/prospects/${p.id}`,
        entityType: 'prospect',
        entityId: String(p.id),
        at: Number(p.next_followup_at),
      });
    }

    // Sort: severity first, then the entity's own date (oldest first), and
    // cap the list so one bad day cannot flood the board.
    const rank: Record<AttentionItem['severity'], number> = { critical: 0, warning: 1, info: 2 };
    items.sort((a, b) => rank[a.severity] - rank[b.severity] || a.at - b.at);
    const severityCounts = { critical: 0, warning: 0, info: 0 };
    for (const it of items) severityCounts[it.severity] += 1;
    const needsAttention = items.slice(0, 50).map(({ at: _sortAt, ...rest }) => rest);

    res.json({
      runningToday,
      scheduledTomorrow,
      onHold,
      dailyReports: { reports: reportsToday, owingJobs },
      needsAttention,
      counts: {
        runningToday: runningToday.length,
        scheduledTomorrow: scheduledTomorrow.length,
        onHold: onHold.length,
        dailyReports: reportsToday.length,
        owingDailyReport: owingJobs.length,
        needsAttention: items.length,
        critical: severityCounts.critical,
        warning: severityCounts.warning,
        info: severityCounts.info,
      },
    });
  }),
);

/* ================================================================== */
/* GET /aging — stage aging across workspaces                          */
/* ================================================================== */

/**
 * Default over-limit thresholds (days a record may sit in a stage before the
 * row is flagged): prospects 21 (one nurture cycle), bids 7 (a quote should
 * leave within a week), deals 21, jobs 14 (no stage should sit for more than
 * two weeks). Operators can override them via the `aging_limits` setting,
 * either per workspace or per stage (`byStage`).
 */
const DEFAULT_AGING_LIMITS = { prospect: 21, bid: 7, deal: 21, job: 14 };

type AgingWorkspace = keyof typeof DEFAULT_AGING_LIMITS;

dashboardRouter.get(
  '/aging',
  ah(async (_req, res) => {
    const db = getDb();
    const at = now();

    const configured = readSetting<{
      prospect?: number;
      bid?: number;
      deal?: number;
      job?: number;
      byStage?: Record<string, number>;
    }>('aging_limits', {});
    const limitFor = (workspace: AgingWorkspace, stage: string): number => {
      const override = configured.byStage?.[stage];
      const ws = configured[workspace];
      const chosen = typeof override === 'number' ? override : typeof ws === 'number' ? ws : DEFAULT_AGING_LIMITS[workspace];
      return chosen;
    };

    // Age = now − the date the record ENTERED its current state:
    // prospects/deals by created_at (no entry stamp exists), bids by
    // started_at, jobs by stage_entered_at. Archived records are excluded;
    // closed-out work simply has nothing left to age.
    const group = (sql: string, workspace: AgingWorkspace) =>
      (db.prepare(sql).all(at) as any[]).map((r) => {
        const avgAgeDays = round2(Number(r.avg_age ?? 0));
        const limit = limitFor(workspace, String(r.stage));
        return {
          workspace,
          stage: r.stage as string,
          count: Number(r.count ?? 0),
          avgAgeDays,
          overLimit: avgAgeDays > limit,
          limit,
        };
      });

    const rows = [
      ...group(
        `SELECT p.stage AS stage, COUNT(*) AS count, AVG((? - p.created_at) / 86400000.0) AS avg_age
           FROM prospects p WHERE p.archived_at IS NULL GROUP BY p.stage ORDER BY count DESC`,
        'prospect',
      ),
      ...group(
        `SELECT b.stage AS stage, COUNT(*) AS count, AVG((? - b.started_at) / 86400000.0) AS avg_age
           FROM bids b WHERE b.archived_at IS NULL GROUP BY b.stage ORDER BY count DESC`,
        'bid',
      ),
      ...group(
        `SELECT d.stage AS stage, COUNT(*) AS count, AVG((? - d.created_at) / 86400000.0) AS avg_age
           FROM deals d WHERE d.archived_at IS NULL GROUP BY d.stage ORDER BY count DESC`,
        'deal',
      ),
      ...group(
        `SELECT j.stage AS stage, COUNT(*) AS count, AVG((? - j.stage_entered_at) / 86400000.0) AS avg_age
           FROM jobs j WHERE j.stage_entered_at IS NOT NULL GROUP BY j.stage ORDER BY count DESC`,
        'job',
      ),
    ];

    res.json({
      rows,
      thresholds: {
        prospect: limitFor('prospect', ''),
        bid: limitFor('bid', ''),
        deal: limitFor('deal', ''),
        job: limitFor('job', ''),
      },
    });
  }),
);