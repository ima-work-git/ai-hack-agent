import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runAgent } from '../server/agent.ts';
import { BudgetLedger } from '../server/budget.ts';
import type { ResearchProvider } from '../server/provider-contract.ts';

it.each([0, 0.002])('retains the full durable reservation for a preliminary report of %s USD', async reportedUsd => {
  const directory=await mkdtemp(join(tmpdir(),'aihack-reported-cost-'));
  try {
    const runId=randomUUID();
    // Synthetic test limits, unrelated to any deployment or account settings.
    const budget=new BudgetLedger({directory,currency:'USD',runLimitUsd:0.25,dayLimitUsd:0.5,eventLimitUsd:0.75});
    const unexpected=async ():Promise<never>=>{throw new Error('Unexpected provider call');};
    const provider:ResearchProvider={mode:'live',plan:async()=>({reportedUsd,value:{target:null,needsConfirmation:true,candidates:[],query:'',reason:'Missing identity'}}),search:unexpected,fetchPage:unexpected,assess:unexpected};
    const result=await runAgent({text:'架空の対象です',requestId:runId,subjectRevision:1,mode:'live',scenario:'normal'},provider,{budget,budgetRunId:runId,maximumCosts:{llm:0.05,search:0.035,page:0}});
    expect(result.status).toBe('awaiting_confirmation');
    expect(result.usage).toMatchObject({reportedUsd,reportedCostCalls:1,actualUsd:null,costKnown:false,reservedUsd:0.05});
    const reopened=new BudgetLedger({directory,currency:'USD',runLimitUsd:0.25,dayLimitUsd:0.5,eventLimitUsd:0.75});
    expect(await reopened.snapshot(runId)).toMatchObject({actualUsd:0,reservedUsd:0.05,eventUsedUsd:0.05,costKnown:false});
  } finally {await rm(directory,{recursive:true,force:true});}
});
