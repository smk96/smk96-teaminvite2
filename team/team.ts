import { Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";

// Real implementation of sendInvitesApi
async function sendInvitesApi(emails: string[], role: string, resend: boolean, token: string, accountId: string) {
    console.log(`Sending invites to ${emails.length} users for account ${accountId}`);

    const url = `https://chat.openai.com/backend-api/teams/${accountId}/invites`;

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            },
            body: JSON.stringify({
                emails: emails,
                role: role,
                resend: resend
            })
        });

        if (!response.ok) {
            const text = await response.text();
            console.error(`API Error (${response.status}):`, text);
            return { success: false, statusCode: response.status, error: text };
        }

        const data = await response.json();
        return { success: true, data };

    } catch (error) {
        console.error("Network or Logic Error in sendInvitesApi:", error);
        throw error;
    }
}

const router = new Router();

// Interfaces
interface Team {
    token: string;
    accountId: string;
    name?: string;
    id?: string;
}

// Lazy KV Initialization
let _kv: Deno.Kv | null = null;

async function getKv() {
    if (!_kv) {
        _kv = await Deno.openKv();
    }
    return _kv;
}

// Helper: Load teams from KV
async function loadTeams(): Promise<Team[]> {
    const kv = await getKv();
    const teams: Team[] = [];
    const entries = kv.list({ prefix: ["teams"] });
    for await (const entry of entries) {
        teams.push(entry.value as Team);
    }
    return teams.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

// Helper: Save a team to KV
async function saveTeam(team: Team) {
    const kv = await getKv();
    if (!team.id) {
        team.id = crypto.randomUUID();
    }
    await kv.set(["teams", team.id], team);
}

// Helper: Delete a team from KV
async function deleteTeam(id: string) {
    const kv = await getKv();
    await kv.delete(["teams", id]);
}

// Helper: Get all available configs (Teams + Env/Global Fallback)
async function getAllConfigs(): Promise<Team[]> {
    const teams = await loadTeams();

    if (teams.length === 0) {
        const fallbackToken = Deno.env.get("CHATGPT_TOKEN");
        const fallbackAccountId = Deno.env.get("CHATGPT_ACCOUNT_ID");

        if (fallbackToken && fallbackAccountId) {
            return [{
                token: fallbackToken,
                accountId: fallbackAccountId,
                name: "Default Env/Global",
                id: "default"
            }];
        }
    }
    return teams;
}

// API: Invite (Manual Selection)
router.post("/api/invite", async (ctx) => {
    const body = await ctx.request.body().value;
    const emails: string[] = body.emails;
    const role = body.role || "reader";
    const resend = body.resend || false;
    const teamId = body.teamId;

    if (!emails || !Array.isArray(emails) || emails.length === 0) {
        ctx.response.status = 400;
        ctx.response.body = { error: "Emails array is required" };
        return;
    }

    const configs = await getAllConfigs();
    if (configs.length === 0) {
        ctx.response.status = 500;
        ctx.response.body = { error: "No team configuration available" };
        return;
    }

    // Validate team selection
    const config = configs.find(t => t.id === teamId) || (configs.length === 1 ? configs[0] : null);

    if (!config) {
        ctx.response.status = 400;
        ctx.response.body = { error: "Invalid or missing team selection" };
        return;
    }

    try {
        const result = await sendInvitesApi(emails, role, resend, config.token, config.accountId);

        ctx.response.status = result.success ? 200 : (result.statusCode || 500);
        ctx.response.body = {
            success: result.success,
            team: config.name,
            details: result
        };
    } catch (err) {
        console.error("Invite Error:", err);
        ctx.response.status = 500;
        ctx.response.body = {
            success: false,
            team: config.name,
            error: err.message
        };
    }
});

// API: Get Teams
router.get("/api/teams", async (ctx) => {
    const teams = await loadTeams();
    ctx.response.body = teams;
});

// API: Add Team
router.post("/api/teams", async (ctx) => {
    const body = await ctx.request.body().value;
    const { token, accountId, name } = body;

    if (!token || !accountId) {
        ctx.response.status = 400;
        ctx.response.body = { error: "Token and Account ID are required" };
        return;
    }

    const newTeam: Team = { token, accountId, name: name || "Team" };
    await saveTeam(newTeam);

    ctx.response.status = 201;
    ctx.response.body = { success: true, team: newTeam };
});

// API: Delete Team
router.delete("/api/teams/:id", async (ctx) => {
    const id = ctx.params.id;
    if (!id) {
        ctx.response.status = 400;
        return;
    }
    await deleteTeam(id);
    ctx.response.body = { success: true };
});

// Management UI
router.get("/manage", (ctx) => {
    ctx.response.headers.set("Content-Type", "text/html");
    ctx.response.body = `
<!DOCTYPE html>
<html lang="zh">
<head>
    <meta charset="UTF-8">
    <title>Team Management</title>
    <style>
        body { font-family: sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
        .card { border: 1px solid #ddd; padding: 15px; margin-bottom: 20px; border-radius: 4px; }
        h2 { margin-top: 0; }
        input, button, select { padding: 8px; margin: 5px 0; }
        table { width: 100%; border-collapse: collapse; }
        th, td { text-align: left; padding: 8px; border-bottom: 1px solid #ddd; }
        .success { color: green; }
        .error { color: red; }
    </style>
</head>
<body>
    <h1>Team Management & Invite System (KV Store)</h1>
    
    <div class="card">
        <h2>Add New Team</h2>
        <input type="text" id="newName" placeholder="Team Name">
        <input type="text" id="newToken" placeholder="Token" style="width: 300px;">
        <input type="text" id="newAccountId" placeholder="Account ID" style="width: 300px;">
        <button onclick="addTeam()">Add Team</button>
    </div>

    <div class="card">
        <h2>Existing Teams</h2>
        <table id="teamsTable">
            <thead><tr><th>Name</th><th>Token (Preview)</th><th>Account ID</th><th>Action</th></tr></thead>
            <tbody></tbody>
        </table>
    </div>

    <div class="card">
        <h2>Send Invites</h2>
        <p>Select a team to send invites from.</p>
        
        <label for="inviteTeamSelect"><strong>Select Team:</strong></label>
        <select id="inviteTeamSelect"></select>
        <br><br>

        <textarea id="inviteEmails" rows="5" style="width: 100%;" placeholder="Enter emails, one per line or comma separated"></textarea>
        <button onclick="sendInvites()">Send Invites</button>
        <div id="inviteResult"></div>
    </div>

    <script>
        let currentTeams = [];

        async function loadTeams() {
            const res = await fetch('/api/teams');
            currentTeams = await res.json();
            
            const tbody = document.querySelector('#teamsTable tbody');
            tbody.innerHTML = '';
            currentTeams.forEach((t) => {
                const tr = document.createElement('tr');
                tr.innerHTML = \`
                    <td>\${t.name}</td>
                    <td>\${t.token.substring(0, 10)}...</td>
                    <td>\${t.accountId}</td>
                    <td><button onclick="deleteTeam('\${t.id}')">Delete</button></td>
                \`;
                tbody.appendChild(tr);
            });

            const select = document.getElementById('inviteTeamSelect');
            const savedSelection = select.value;
            select.innerHTML = '';
            
            if (currentTeams.length === 0) {
                 const option = document.createElement('option');
                 option.text = "No teams available";
                 select.add(option);
            } else {
                currentTeams.forEach((t) => {
                    const option = document.createElement('option');
                    option.value = t.id;
                    option.text = t.name;
                    select.add(option);
                });
                if (savedSelection) select.value = savedSelection;
            }
        }

        async function addTeam() {
            const name = document.getElementById('newName').value;
            const token = document.getElementById('newToken').value;
            const accountId = document.getElementById('newAccountId').value;
            
            if(!token || !accountId) return alert('Token and Account ID required');

            await fetch('/api/teams', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ name, token, accountId })
            });
            
            document.getElementById('newName').value = '';
            document.getElementById('newToken').value = '';
            document.getElementById('newAccountId').value = '';
            loadTeams();
        }

        async function deleteTeam(id) {
            if(!confirm('Are you sure?')) return;
            await fetch(\`/api/teams/\${id}\`, { method: 'DELETE' });
            loadTeams();
        }

        async function sendInvites() {
            const text = document.getElementById('inviteEmails').value;
            const emails = text.split(/[\\n,]/).map(e => e.trim()).filter(e => e);
            const teamId = document.getElementById('inviteTeamSelect').value;

            if(emails.length === 0) return alert('No emails entered');
            if(!teamId) return alert('Please select a team');

            const btn = document.querySelector('button[onclick="sendInvites()"]');
            btn.disabled = true;
            btn.innerText = 'Sending...';

            try {
                const res = await fetch('/api/invite', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ emails, teamId })
                });
                const data = await res.json();
                
                let html = '';
                if (data.success) {
                    html = \`<p class="success">Successfully sent invites using <strong>\${data.team}</strong>.</p>\`;
                } else {
                    html = \`<p class="error">Failed: \${data.error || 'Unknown error'}</p>\`;
                }
                document.getElementById('inviteResult').innerHTML = html;
            } catch(e) {
                document.getElementById('inviteResult').innerHTML = '<p class="error">Error sending invites</p>';
            }
            
            btn.disabled = false;
            btn.innerText = 'Send Invites';
        }

        loadTeams();
    </script>
</body>
</html>
  `;
});

// API: Get config (Legacy/Current Context)
router.get("/api/config", async (ctx) => {
    const configs = await getAllConfigs();
    const config = configs[0] || {};

    ctx.response.headers.set("Content-Type", "application/json");
    ctx.response.body = {
        token: config.token,
        accountId: config.accountId,
        hasConfig: !!config.token
    };
});

// Health check
router.get("/health", async (ctx) => {
    const configs = await getAllConfigs();
    ctx.response.headers.set("Content-Type", "application/json");
    ctx.response.body = {
        status: "ok",
        teamsCount: configs.length
    };
});

export default router;
