"""Whether a site's robots.txt lets us fetch a URL.

`allows` is the matcher: groups of `User-agent` lines own the rules that follow
them; the most specific group whose agent is `*` or a substring of `token` applies (equal ranks combine); the
longest matching `Allow`/`Disallow` pattern (`*` wildcard, `$` anchor) wins, and allowed when none matches.

`decide` adds the fetch policy: a 2xx robots.txt is parsed, a 404 or 410 means no rules, and any other status
(401, 403, 429, 5xx, a redirect) refuses the site, because we cannot tell what it allows.

`access` adds one more rule, because these scrapers are written and run by AI agents: a site whose robots.txt names
an AI agent (ClaudeBot, GPTBot, ChatGPT-User, ...) and disallows the URL for it has opted out of AI agents, and we
treat that as a refusal even when our own user agent is not named. The result carries a `code` the app shows.
"""
import re
import urllib.parse


class NoGroup(ValueError):
    pass


def allows(raw, url, token):
    groups, agents, rules, started = [], [], [], False
    text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
    for line in text.splitlines() + ["User-agent: __end__"]:
        line = line.split("#", 1)[0].strip()
        if ":" not in line:
            continue
        key, value = (piece.strip() for piece in line.split(":", 1))
        key = key.lower()
        if key == "user-agent":
            if started:
                groups.append((agents, rules))
                agents, rules, started = [], [], False
            agents.append(value.lower())
        elif agents and key in {"allow", "disallow"}:
            started = True
            if value:
                rules.append((key == "allow", value))
    token = token.lower()
    ranked = [(max((len(agent) if agent != "*" else 0 for agent in group if agent == "*" or agent in token),
                   default=-1), group_rules) for group, group_rules in groups]
    best = max((rank for rank, _ in ranked), default=-1)
    if best < 0:
        raise NoGroup("robots has no group for this agent")
    part = urllib.parse.urlsplit(url)
    target = (part.path or "/") + ("?" + part.query if part.query else "")
    decisions = []
    for allow, pattern in (rule for rank, group_rules in ranked if rank == best for rule in group_rules):
        terminal = pattern.endswith("$")
        pattern = pattern[:-1] if terminal else pattern
        regex = "^" + re.escape(pattern).replace(r"\*", ".*") + ("$" if terminal else "")
        if re.search(regex, target):
            decisions.append((len(pattern.replace("*", "")), allow))
    return max(decisions, default=(0, True))[1]


def decide(status, body, url, token):
    """(allowed, reason) for `url` under a robots.txt response. Only rules the site wrote refuse: a robots.txt that
    can't be read (404, 403, 5xx…) has none, so the site is collected; a page that then answers 401/403/429 is
    refused on its own (Refused, a `blocked` build or scrape)."""
    if not 200 <= status < 300:
        return True, f"robots.txt {status}: no rules" if status in (404, 410) else f"robots.txt answered {status}: no rules read"
    try:
        allowed = allows(body, url, token)
    except NoGroup:
        return True, "robots.txt has no group for this agent or *"
    return allowed, "robots.txt allows" if allowed else "robots.txt disallows"


AI_AGENTS = ("ClaudeBot", "Claude-User", "anthropic-ai", "GPTBot", "ChatGPT-User", "PerplexityBot", "Perplexity-User")


def _named(body, agent):
    """Whether a group of the robots.txt names `agent` itself (not only `*`)."""
    names = {line.split(":", 1)[1].strip().lower() for line in body.splitlines()
             if line.split("#", 1)[0].strip().lower().startswith("user-agent:")}
    return agent.lower() in names


def access(status, body, url, token):
    """{"status": "allowed" | "refused", "code", "reason"} for `url`, AI-agent opt-outs included.

    Codes: allowed, no_robots (no robots.txt, or one that can't be read), robots_disallow, ai_opt_out."""
    allowed, reason = decide(status, body, url, token)
    if not allowed:
        return {"status": "refused", "code": "robots_disallow", "reason": reason}
    if 200 <= status < 300:
        blocked = [agent for agent in AI_AGENTS if _named(body, agent) and not allows(body, url, agent)]
        if blocked:
            return {"status": "refused", "code": "ai_opt_out",
                    "reason": f"robots.txt blocks AI agents ({', '.join(blocked)})"}
    return {"status": "allowed", "code": "allowed" if 200 <= status < 300 else "no_robots", "reason": reason}


def sitemaps(body):
    """The `Sitemap:` URLs a robots.txt names."""
    return [line.split(":", 1)[1].strip() for line in body.splitlines() if line.lower().startswith("sitemap:")]
