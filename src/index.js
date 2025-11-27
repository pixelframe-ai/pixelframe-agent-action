'use strict';

const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const ACTION_VERSION = '2.1.0';

// ═══════════════════════════════════════════════════════════════════════════
// MULTI-AGENT PIPELINE CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════
const PIPELINE_CONFIG = {
  agents: {
    ticket: { name: 'Agent 1: Ticket Analysis', model: 'Grok-4' },
    coder: { name: 'Agent 2: Code Generation', model: 'Opus 4.5' },
    reviewer: { name: 'Agent 3: Verification', model: 'Codex' },
  },
  // Status messages for each agent stage
  messages: {
    coder: {
      pending: 'Waiting to start...',
      starting: 'Analyzing codebase structure...',
      thinking: 'Planning code changes...',
      generating: 'Generating code...',
      completed: 'Code generated',
      failed: 'Code generation failed',
    },
    reviewer: {
      pending: 'Waiting for code...',
      starting: 'Verifying acceptance criteria...',
      validating: 'Checking syntax and patterns...',
      completed: 'Verification passed',
      issues: 'Issues found, regenerating...',
      failed: 'Verification failed',
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// GITHUB ACTIONS HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function formatInputKey(name) {
  return `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
}

function getInput(name, options = {}) {
  const key = formatInputKey(name);
  const value = process.env[key];
  if (!value || value.trim() === '') {
    if (options.required) {
      throw new Error(`Input required and not supplied: ${name}`);
    }
    return '';
  }
  return value.trim();
}

function appendOutputLine(line) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    return fs.appendFile(outputPath, `${line}\n`).catch((error) => {
      console.error(`::warning::Failed to write to GITHUB_OUTPUT: ${error.message}`);
    });
  }
  console.log(`::set-output ${line}`);
  return Promise.resolve();
}

async function setOutput(name, value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  await appendOutputLine(`name=${name}::${serialized}`);
}

function setFailed(message) {
  console.error(`::error::${message}`);
  process.exitCode = 1;
}

function toDebug(message) {
  if (process.env.RUNNER_DEBUG === '1') {
    console.log(`::debug::${message}`);
  }
}

function toNotice(message) {
  console.log(`::notice::${message}`);
}

function toWarning(message) {
  console.warn(`::warning::${message}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// AGENT STATUS LOGGING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Log agent status with visual formatting
 */
function logAgentStatus(agentKey, status, details = {}) {
  const agent = PIPELINE_CONFIG.agents[agentKey];
  if (!agent) return;

  const statusIcons = {
    pending: '⏳',
    starting: '🔄',
    thinking: '🔄',
    generating: '🔄',
    validating: '🔄',
    completed: '✅',
    issues: '⚠️',
    failed: '❌',
  };

  const icon = statusIcons[status] || '🔄';
  const message = details.message || PIPELINE_CONFIG.messages[agentKey]?.[status] || status;
  
  // Format: [icon] Agent Name (Model): Message
  const logLine = `${icon} ${agent.name} [${agent.model}]: ${message}`;
  
  if (status === 'failed') {
    toWarning(logLine);
  } else {
    toNotice(logLine);
  }

  // Log additional details
  if (details.files_count) {
    toNotice(`   └─ ${details.files_count} files modified`);
  }
  if (details.issues_count) {
    toNotice(`   └─ ${details.issues_count} issues found`);
  }
}

/**
 * Log the pipeline header
 */
function logPipelineStart() {
  toNotice('═══════════════════════════════════════════════════════════');
  toNotice('  PIXELFRAME MULTI-AGENT PIPELINE');
  toNotice('═══════════════════════════════════════════════════════════');
  toNotice('');
  
  // Agent 1 (Ticket) is always already done
  logAgentStatus('ticket', 'completed', { message: 'Ticket requirements analyzed' });
}

/**
 * Log the pipeline completion
 */
function logPipelineComplete(prNumber, prUrl) {
  toNotice('');
  toNotice('═══════════════════════════════════════════════════════════');
  if (prNumber) {
    toNotice(`  ✅ PR #${prNumber} CREATED SUCCESSFULLY`);
    if (prUrl) {
      toNotice(`  📎 ${prUrl}`);
    }
  } else {
    toNotice('  ✅ PIPELINE COMPLETED');
  }
  toNotice('═══════════════════════════════════════════════════════════');
}

// ═══════════════════════════════════════════════════════════════════════════
// JSON & REPOSITORY HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function parseJsonFile(contents, filePath) {
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Failed to parse JSON from ${filePath}: ${error.message}`);
  }
}

function parseRepository(repoString) {
  if (!repoString) {
    return null;
  }
  const [owner, name] = repoString.split('/');
  if (!owner || !name) {
    return null;
  }
  return { owner, name };
}

function buildContextSnapshot() {
  return {
    repository: process.env.GITHUB_REPOSITORY || null,
    repositoryOwner: process.env.GITHUB_REPOSITORY_OWNER || null,
    ref: process.env.GITHUB_REF || null,
    sha: process.env.GITHUB_SHA || null,
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    workflow: process.env.GITHUB_WORKFLOW || null,
    eventName: process.env.GITHUB_EVENT_NAME || null,
    actor: process.env.GITHUB_ACTOR || null,
    job: process.env.GITHUB_JOB || null,
  };
}

function resolveAgentUrl(payload, inputBaseUrl) {
  if (payload && typeof payload === 'object') {
    const candidates = [
      payload.agentUrl,
      payload.agent_url,
      payload.agent_endpoint,
      payload.agentEndpoint,
      payload.url,
      payload.endpoint,
    ].filter(Boolean);
    if (candidates.length > 0) {
      return candidates[0];
    }
  }

  const base = inputBaseUrl || process.env.PIXELFRAME_BASE_URL || '';
  if (!base) {
    return null;
  }

  try {
    return new URL('/agent/run', base).toString();
  } catch (error) {
    throw new Error(`Invalid PixelFrame base URL: ${error.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// AGENT API COMMUNICATION
// ═══════════════════════════════════════════════════════════════════════════

// Track last logged status to avoid duplicate logs
let lastLoggedStatus = {};

async function pollAgentStatus(baseUrl, apiKey, runId) {
  const statusUrl = new URL(`/agent/status/${runId}`, baseUrl).toString();
  const maxAttempts = 120; // 10 minutes (5s * 120)
  const pollInterval = 5000; // 5 seconds

  toNotice(`Job ${runId} started, polling for completion (max 10 minutes)...`);
  toNotice('');

  // Reset status tracking
  lastLoggedStatus = {};

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const headers = {
      'User-Agent': `pixelframe-agent-action/${ACTION_VERSION}`,
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    toDebug(`Polling attempt ${attempt + 1}/${maxAttempts} - ${statusUrl}`);

    const response = await fetch(statusUrl, { method: 'GET', headers });
    const raw = await response.text();

    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      toWarning(`Status response is not valid JSON: ${error.message}`);
      continue;
    }

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Job ${runId} not found (404)`);
      }
      if (response.status === 410) {
        throw new Error(`Job ${runId} expired (410)`);
      }
      throw new Error(`Status check failed (${response.status}): ${raw.slice(0, 200)}`);
    }

    // ═══════════════════════════════════════════════════════════════════
    // LOG DETAILED AGENT STATUS
    // ═══════════════════════════════════════════════════════════════════
    if (data.pipeline) {
      const { coder, reviewer } = data.pipeline;

      // Log coder status changes
      if (coder && coder.status !== lastLoggedStatus.coder) {
        logAgentStatus('coder', coder.status, {
          message: coder.message,
          files_count: coder.files_count,
        });
        lastLoggedStatus.coder = coder.status;
      }

      // Log reviewer status changes
      if (reviewer && reviewer.status !== lastLoggedStatus.reviewer) {
        logAgentStatus('reviewer', reviewer.status, {
          message: reviewer.message,
          issues_count: reviewer.issues_count,
        });
        lastLoggedStatus.reviewer = reviewer.status;
      }
    }

    // Check completion status
    if (data.status === 'completed') {
      const elapsed = Math.round(((attempt + 1) * pollInterval) / 1000);
      toNotice('');
      toNotice(`Job ${runId} completed after ${elapsed}s`);
      return data;
    }

    if (data.status === 'failed') {
      toWarning(`Job ${runId} failed: ${data.error || 'Unknown error'}`);
      return data.result || data;
    }

    if (data.status === 'processing') {
      const elapsed = data.elapsed_seconds || (attempt + 1) * 5;
      toDebug(`Still processing... (${elapsed}s elapsed)`);
      continue;
    }

    toWarning(`Unknown status: ${data.status}`);
  }

  throw new Error(`Job ${runId} timed out after 10 minutes`);
}

async function callAgent(agentUrl, apiKey, payload, context, metadata) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': `pixelframe-agent-action/${ACTION_VERSION}`,
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const body = JSON.stringify({
    payload,
    context,
    metadata,
  });

  toDebug(`Calling PixelFrame agent at ${agentUrl}`);

  const response = await fetch(agentUrl, {
    method: 'POST',
    headers,
    body,
  });

  const raw = await response.text();

  let data;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch (error) {
      toWarning(`Agent response is not valid JSON: ${error.message}`);
      data = { raw };
    }
  }

  if (!response.ok) {
    const snippet = raw ? raw.slice(0, 500) : 'No response body';
    throw new Error(
      `PixelFrame API request failed (${response.status} ${response.statusText}): ${snippet}`
    );
  }

  // If status is "processing", poll until complete
  if (data && data.status === 'processing' && data.runId) {
    const baseUrl = new URL(agentUrl).origin;
    data = await pollAgentStatus(baseUrl, apiKey, data.runId);
  }

  return data;
}

// ═══════════════════════════════════════════════════════════════════════════
// FILE OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

function normalizeFileChanges(files) {
  if (!Array.isArray(files)) {
    return [];
  }
  return files
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || !entry.path) {
        return null;
      }
      const encoding = entry.encoding || entry.contentEncoding || 'utf-8';
      const mode = entry.mode || 'text';
      return {
        path: entry.path,
        contents: entry.contents ?? entry.content ?? '',
        encoding,
        mode,
      };
    })
    .filter(Boolean);
}

async function writeFileChange(change) {
  const filePath = path.resolve(process.cwd(), change.path);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  let data = change.contents;
  if (change.encoding === 'base64') {
    data = Buffer.from(change.contents, 'base64');
  }

  if (change.mode === 'binary') {
    await fs.writeFile(filePath, data);
  } else {
    const normalized = typeof data === 'string' ? data : data.toString('utf-8');
    await fs.writeFile(filePath, normalized, 'utf-8');
  }
}

async function removeFile(pathToRemove) {
  const resolved = path.resolve(process.cwd(), pathToRemove);
  await fs.rm(resolved, { force: true, recursive: true });
}

async function applyFileOperations(plan) {
  const updates = normalizeFileChanges(plan.files || plan.updates || []);
  
  if (updates.length > 0) {
    toNotice(`📝 Applying ${updates.length} file changes...`);
  }
  
  for (const change of updates) {
    await writeFileChange(change);
    toDebug(`Wrote file ${change.path}`);
  }

  const deletions = Array.isArray(plan.deletions) ? plan.deletions : [];
  for (const item of deletions) {
    if (typeof item === 'string') {
      await removeFile(item);
      toDebug(`Removed file ${item}`);
    } else if (item && typeof item.path === 'string') {
      await removeFile(item.path);
      toDebug(`Removed file ${item.path}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GIT OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.silent ? 'ignore' : 'inherit',
      env: options.env || process.env,
      cwd: options.cwd || process.cwd(),
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

async function ensureGitUserConfigured(commitConfig = {}) {
  const name = commitConfig.name || process.env.GIT_COMMITTER_NAME || 'pixelframe-agent';
  const email = commitConfig.email || process.env.GIT_COMMITTER_EMAIL || 'pixelframe@git.local';

  await runCommand('git', ['config', 'user.name', name]);
  await runCommand('git', ['config', 'user.email', email]);
}

async function prepareBranch(branchName, baseBranch) {
  await runCommand('git', ['fetch', '--prune', '--tags']);

  const baseRef = baseBranch || process.env.GITHUB_BASE_REF || process.env.GITHUB_REF_NAME || 'main';

  await runCommand('git', ['checkout', baseRef]);
  await runCommand('git', ['pull', '--ff-only', 'origin', baseRef]);
  await runCommand('git', ['checkout', '-B', branchName, baseRef]);
}

async function stageAndCommit(message) {
  await runCommand('git', ['add', '--all']);

  try {
    await runCommand('git', ['diff', '--cached', '--quiet']);
    toNotice('No staged changes detected; skipping commit.');
    return false;
  } catch (error) {
    await runCommand('git', ['commit', '-m', message]);
    return true;
  }
}

async function pushBranch(branchName, force) {
  const args = ['push', 'origin', branchName];
  if (force) {
    args.splice(1, 0, '--force-with-lease');
  }
  await runCommand('git', args);
}

// ═══════════════════════════════════════════════════════════════════════════
// GITHUB API OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

async function githubRequest(token, method, url, body) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'User-Agent': `pixelframe-agent-action/${ACTION_VERSION}`,
    Accept: 'application/vnd.github+json',
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      toWarning(`GitHub API response from ${url} is not valid JSON: ${error.message}`);
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const snippet = text ? text.slice(0, 400) : 'No response body';
    throw new Error(`GitHub API request failed (${response.status} ${response.statusText}): ${snippet}`);
  }

  return data;
}

async function createOrUpdatePullRequest(repo, branchName, baseBranch, pullRequestSpec, token) {
  if (!repo || !branchName || !token) {
    return null;
  }

  const base = baseBranch || 'main';
  const title = pullRequestSpec.title || `Updates from PixelFrame agent (${branchName})`;
  const body = pullRequestSpec.body || '';
  const draft = pullRequestSpec.draft === true;
  const prNumber = pullRequestSpec.number || pullRequestSpec.prNumber;

  if (prNumber) {
    toNotice(`📝 Updating pull request #${prNumber}`);
    await githubRequest(
      token,
      'PATCH',
      `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${prNumber}`,
      {
        title,
        body,
        draft,
      }
    );
    return prNumber;
  }

  toNotice(`🔀 Creating pull request from ${branchName} to ${base}`);

  const pr = await githubRequest(
    token,
    'POST',
    `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls`,
    {
      head: branchName,
      base,
      title,
      body,
      draft,
    }
  );
  return pr && pr.number ? pr.number : null;
}

async function requestReviewsIfNeeded(repo, pullRequestNumber, reviewers, token) {
  if (!repo || !pullRequestNumber || !token) {
    return;
  }

  const users = Array.isArray(reviewers?.users) ? reviewers.users : reviewers || [];
  const teams = Array.isArray(reviewers?.teams) ? reviewers.teams : [];

  if (users.length === 0 && teams.length === 0) {
    return;
  }

  await githubRequest(
    token,
    'POST',
    `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pullRequestNumber}/requested_reviewers`,
    {
      reviewers: users,
      team_reviewers: teams,
    }
  );
}

async function maybeMergePullRequest(repo, pullRequestNumber, mergeStrategy, token) {
  if (!repo || !pullRequestNumber || !token || !mergeStrategy) {
    return;
  }

  const method = mergeStrategy.toLowerCase();
  if (!['merge', 'squash', 'rebase'].includes(method)) {
    toWarning(`Unsupported merge strategy "${mergeStrategy}". Skipping merge step.`);
    return;
  }

  await githubRequest(
    token,
    'PUT',
    `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pullRequestNumber}/merge`,
    {
      merge_method: method,
    }
  );
  toNotice(`Pull request #${pullRequestNumber} merged using ${method} strategy.`);
}

// ═══════════════════════════════════════════════════════════════════════════
// REPOSITORY PLAN APPLICATION
// ═══════════════════════════════════════════════════════════════════════════

async function maybeApplyRepositoryPlan(plan, token, mergeStrategy) {
  if (!plan || typeof plan !== 'object') {
    return { prNumber: null, prUrl: null };
  }

  const repo = parseRepository(plan.repository?.name || process.env.GITHUB_REPOSITORY);
  if (!repo) {
    toWarning('Unable to determine repository for PR operations.');
  }

  const commit = plan.commit || {};
  const branchName = commit.branch || plan.branch || plan.branchName;

  if (!branchName) {
    toNotice('Agent response did not include branch information; skipping repository operations.');
    return { prNumber: null, prUrl: null };
  }

  if (!token) {
    toWarning('No GitHub token provided; cannot push commits or manage pull requests.');
    return { prNumber: null, prUrl: null };
  }

  await ensureGitUserConfigured(commit.author);
  await prepareBranch(branchName, commit.base || plan.baseBranch);
  await applyFileOperations(plan);

  const committed = await stageAndCommit(commit.message || plan.commitMessage || 'PixelFrame agent updates');
  if (!committed) {
    toNotice('No changes detected after applying agent plan.');
    return { prNumber: null, prUrl: null };
  }

  await pushBranch(branchName, commit.force === true || plan.force === true);

  const prSpec = plan.pullRequest || {};
  const prNumber = await createOrUpdatePullRequest(repo, branchName, commit.base || plan.baseBranch, prSpec, token);

  let prUrl = null;
  if (prNumber && repo) {
    prUrl = `https://github.com/${repo.owner}/${repo.name}/pull/${prNumber}`;
  }

  if (prNumber && prSpec.reviewers) {
    await requestReviewsIfNeeded(repo, prNumber, prSpec.reviewers, token);
  }

  const shouldMerge = prSpec.merge === true || plan.merge === true;
  if (shouldMerge) {
    await maybeMergePullRequest(repo, prNumber, mergeStrategy || prSpec.mergeStrategy, token);
  }

  return { prNumber, prUrl };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

async function run() {
  try {
    const payloadFile = getInput('payload-file', { required: true });
    const token = getInput('token') || process.env.GITHUB_TOKEN || '';
    const mergeStrategy = getInput('merge-strategy');
    const pixelframeBaseUrl = getInput('pixelframe-base-url');

    // NOTE: agent-provider input removed - pipeline is now fixed
    // (Grok-4 for tickets, Opus 4.5 for code, Codex for verification)

    const payloadPath = path.resolve(process.cwd(), payloadFile);
    const payloadRaw = await fs.readFile(payloadPath, 'utf-8');
    const payload = parseJsonFile(payloadRaw, payloadPath);

    const agentUrl = resolveAgentUrl(payload, pixelframeBaseUrl);
    if (!agentUrl) {
      throw new Error(
        'Unable to resolve PixelFrame agent endpoint. Provide `pixelframe-base-url` input or `agentUrl` inside the payload.'
      );
    }

    const apiKey = process.env.PIXELFRAME_API_KEY || '';
    if (!apiKey) {
      toWarning('PIXELFRAME_API_KEY is not set; attempting to call agent without authentication.');
    }

    // Log pipeline start
    logPipelineStart();

    const contextSnapshot = buildContextSnapshot();
    const metadata = {
      // Fixed pipeline - no agent selection
      pipeline: 'multi-agent-v2',
      mergeStrategy: mergeStrategy || undefined,
      actionVersion: ACTION_VERSION,
    };

    const agentResponse = await callAgent(agentUrl, apiKey, payload, contextSnapshot, metadata);

    if (agentResponse && typeof agentResponse === 'object') {
      if (agentResponse.runId) {
        await setOutput('run-id', String(agentResponse.runId));
      }
      if (agentResponse.status) {
        await setOutput('status', agentResponse.status);
      }
    }

    const { prNumber, prUrl } = await maybeApplyRepositoryPlan(
      agentResponse?.plan || agentResponse,
      token,
      mergeStrategy
    );

    // Set PR outputs
    if (prNumber) {
      await setOutput('pr-number', String(prNumber));
    }
    if (prUrl) {
      await setOutput('pr-url', prUrl);
    }

    // Log pipeline completion
    logPipelineComplete(prNumber, prUrl);

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setFailed(message);
  }
}

run();

