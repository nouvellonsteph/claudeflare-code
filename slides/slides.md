---
theme: default
title: Claudeflare Code | Zero Trust Egress
info: |
  A technical walkthrough of HTTP and TCP capture from Cloudflare Containers,
  identity-aware inspection, and SSH with Access for Infrastructure.
transition: slide-left
mdc: true
layout: cover
class: cf-cover
---

<div class="eyebrow">CLAUDEFLARE CODE / IMPLEMENTATION WALKTHROUGH</div>

# Agent freedom.<br><span>Zero direct egress.</span>

<p class="lede">Every container request takes an identity-aware Cloudflare path. HTTP is inspected. Private SSH is authorized with short-lived certificates. Public fallback is off.</p>

<div class="hero-proof">
  <div><strong>HTTP/S</strong><span>captured + inspected</span></div>
  <div><strong>SSH/TCP</strong><span>private destination only</span></div>
  <div><strong>Internet</strong><span>no direct route</span></div>
</div>

<div class="cover-rule"></div>

<!--
Open with the outcome, not the product list: the agent keeps developer utility without receiving a path around policy. The phrase to repeat is "no direct egress from the container."
-->

---
layout: default
---

<div class="eyebrow">THE CONTROL PLANE</div>

## One identity follows every connection

<div class="three-up">
  <div class="cf-card">
    <span class="step">01</span>
    <h3>Authenticate</h3>
    <p>Cloudflare Access verifies the user and passes the email identity into the per-user Durable Object.</p>
    <code>Cf-Access-Jwt-Assertion</code>
  </div>
  <div class="cf-card">
    <span class="step">02</span>
    <h3>Capture</h3>
    <p>Container outbound hooks capture HTTP/S. A targeted TCP interceptor captures the private infrastructure destination.</p>
    <code>enableInternet = false</code>
  </div>
  <div class="cf-card accent-card">
    <span class="step">03</span>
    <h3>Enforce</h3>
    <p>The identity-scoped VPC fetcher carries traffic into Zero Trust for policy, inspection, and logs.</p>
    <code>newFetcher(user)</code>
  </div>
</div>

<div class="statement-strip">The container never receives a bypass route or a long-lived infrastructure credential.</div>

<!--
The same Access identity controls the workspace and egress. Emphasize that secrets remain in the Worker runtime, outside the container boundary.
-->

---
layout: default
class: diagram-slide
---

<div class="eyebrow">INTERACTIVE ARCHITECTURE</div>

## Follow the packet

<ImplementationDiagram />

<!--
Use the three controls in sequence. HTTP shows inspection and AI Gateway. SSH/TCP shows the private target and certificate flow. Direct internet shows the absent bypass path enforced by enableInternet=false.
-->

---
layout: two-cols-header
---

<div class="eyebrow">PATH 01 / HTTP + HTTPS</div>

## Inspection happens outside the container

::left::

```ts {2,5-8|10-14}
class ClaudeCodeContainer extends Container {
  interceptHttps = true;
  enableInternet = false;
}

ClaudeCodeContainer.outbound = async (request, env, ctx) => {
  const user = await getUserEmail(ctx.containerId);
  const identity = await env.GATEWAY_IDENTITY.newFetcher(user);

  return identity.fetch(request);
};
```

::right::

<div class="path-list">
  <div><span>1</span><p><strong>Capture all HTTP/S</strong><br>including package managers, Git, and API calls.</p></div>
  <div><span>2</span><p><strong>Attach user identity</strong><br>without exposing Gateway credentials to the container.</p></div>
  <div><span>3</span><p><strong>Inspect in Zero Trust</strong><br>then allow or block under Gateway policy.</p></div>
</div>

<div class="micro-proof"><b>Special route:</b> <code>anthropic.proxy</code> is translated and sent through AI Gateway using the same identity fetcher.</div>

<!--
The outbound handler runs in trusted Workers code, not inside the container. That separation is why credentials can be added safely and policy cannot be modified by code running in the workspace.
-->

---
layout: two-cols-header
---

<div class="eyebrow">PATH 02 / PRIVATE SSH</div>

## Native SSH, ephemeral trust

::left::

<div class="ssh-terminal">
  <div class="terminal-bar"><i></i><i></i><i></i><span>container / bash</span></div>
  <div class="terminal-content">
    <div><span>$</span> ssh deploy@10.154.0.33</div>
    <div class="terminal-gap"></div>
    <div>identity&nbsp;&nbsp; user@company.com</div>
    <div>route&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; private / Zero Trust</div>
    <div>auth&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; short-lived SSH cert</div>
    <div>policy&nbsp;&nbsp;&nbsp;&nbsp; target + username</div>
    <div class="terminal-gap"></div>
    <div><b>connected</b>&nbsp; no static key mounted</div>
  </div>
</div>

::right::

<div class="path-list compact">
  <div><span>1</span><p><strong>Capture private TCP</strong><br><code>interceptOutboundTcp("10.154.0.33", identity)</code></p></div>
  <div><span>2</span><p><strong>Authorize the target</strong><br>Access for Infrastructure checks identity, port, and SSH username.</p></div>
  <div><span>3</span><p><strong>Issue ephemeral trust</strong><br>The server trusts Cloudflare's Gateway SSH CA, not a user's long-lived key.</p></div>
  <div><span>4</span><p><strong>Retain evidence</strong><br>Access decisions and optional encrypted SSH command logs support audit.</p></div>
</div>

<!--
Be precise: this repository wires the identity-scoped TCP path. The Infrastructure Access target, application policy, Tunnel route, Gateway SSH CA, and sshd trust are Zero Trust prerequisites configured outside this Worker.
-->

---
layout: default
---

<div class="eyebrow">WHY BYPASS FAILS</div>

## Deny by default is the architecture

<div class="proof-grid">
  <div class="proof-code">
    <span>CONTAINER NETWORK</span>
    <code>enableInternet = false</code>
    <p>No unmatched connection falls through to public internet egress.</p>
  </div>
  <div class="proof-arrow">→</div>
  <div class="proof-code">
    <span>EXPLICIT PATHS</span>
    <code>outbound + interceptOutboundTcp</code>
    <p>Only captured traffic can leave the container boundary.</p>
  </div>
  <div class="proof-arrow">→</div>
  <div class="proof-code accent">
    <span>CLOUDFLARE ONE</span>
    <code>newFetcher(user)</code>
    <p>Policy, identity, inspection, and logs travel together.</p>
  </div>
</div>

<div class="evidence-row">
  <div><b>Gateway logs</b><span>HTTP + network decisions</span></div>
  <div><b>Access logs</b><span>who reached which target</span></div>
  <div><b>SSH logs</b><span>optional command evidence</span></div>
  <div><b>AI Gateway</b><span>model usage by identity</span></div>
</div>

<p class="accuracy-note"><b>Precise claim:</b> no traffic exits directly from a container. An approved request may reach an external service only after the trusted Worker and Zero Trust path allow it.</p>

<!--
This is the proof slide. Avoid saying the platform can never contact an internet service: approved HTTP may do so after Gateway. The security guarantee is that the container has no direct, uninspected path.
-->

---
layout: center
class: cf-close
---

<div class="eyebrow">THE OUTCOME</div>

## The workspace stays useful.<br><span>The network stays governed.</span>

<div class="close-pills">
  <span>Per-user isolation</span>
  <span>Identity-aware egress</span>
  <span>Short-lived SSH trust</span>
  <span>Unified evidence</span>
</div>

<p class="close-line">Cloudflare Containers + Workers VPC + Zero Trust + AI Gateway</p>

<!--
Close on the operating model: developers use familiar tools, while every outbound path is deliberate, attributable, and enforceable.
-->
