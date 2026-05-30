const DB_VERSION = 4;

let accounts = {}; // { [username]: { password: '...', company: '...' } }
let teams = {}; // { [teamId]: { id, name, owner, partners: [] } }
let settings = {}; // { [teamId]: { machineTypes: [], festivals: [] } }
let workers = []; // Array of { ..., teamId }
let attendanceData = {}; // { [date]: { [workerId]: { ..., teamId } } }

let currentUser = null;
let currentTeamId = null;
let currentUserRole = null; // 'owner' | 'partner'
let currentDate = new Date().toISOString().split('T')[0];

// Search state
let workerSearchQuery = '';
let attendanceSearchQuery = '';

// Firebase state
let db = null;
let firebaseActive = false;

document.addEventListener('DOMContentLoaded', () => initApp());

window.openFirebaseGuide = function() {
    const modal = document.getElementById('firebase-guide-modal');
    if (modal) modal.classList.add('active');
};

function setupFirebase() {
    const banner = document.getElementById('sync-banner');
    const statusIcon = document.getElementById('cloud-status-icon');
    
    if (typeof firebase !== 'undefined' && isFirebaseConfigured()) {
        try {
            firebase.initializeApp(firebaseConfig);
            db = firebase.database();
            firebaseActive = true;
            console.log("Firebase initialized successfully.");
            
            if (banner) {
                banner.className = 'sync-banner online';
                banner.innerHTML = `<i class="fas fa-cloud"></i> <span>Cloud Sync Active. Your data is synced automatically.</span>`;
                setTimeout(() => { banner.style.display = 'none'; }, 4000);
            }
            if (statusIcon) {
                statusIcon.className = 'cloud-status-icon online';
                statusIcon.innerHTML = `<i class="fas fa-cloud"></i>`;
                statusIcon.title = "Cloud Sync Enabled";
            }
        } catch (err) {
            console.error("Firebase init error:", err);
            firebaseActive = false;
        }
    }
    
    if (!firebaseActive) {
        console.log("Firebase inactive. Operating in Local Mode.");
        if (banner) {
            banner.style.display = 'flex';
            banner.className = 'sync-banner offline';
        }
        if (statusIcon) {
            statusIcon.className = 'cloud-status-icon offline';
            statusIcon.innerHTML = `<i class="fas fa-cloud-slash"></i>`;
            statusIcon.title = "Local Mode Only (Setup Cloud Sync)";
        }
    }
}

function initApp() {
    setupFirebase();
    loadData();

    const loggedInUser = localStorage.getItem('embroidery_activeUser');
    if (loggedInUser && accounts[loggedInUser]) {
        currentUser = loggedInUser;
        determineTeamAndShowApp(currentUser);
    } else {
        document.getElementById('auth-screen').classList.add('active');
        document.getElementById('app-content-screen').classList.remove('active');
    }

    setupEventListeners();
    document.getElementById('attendance-date').value = currentDate;
    document.getElementById('attendance-date').max = currentDate;
    document.getElementById('report-month').value = currentDate.substring(0, 7);
    document.getElementById('report-month').addEventListener('change', renderReports);
}

function loadData() {
    // Basic Accounts
    const savedAccounts = localStorage.getItem('embroidery_accounts');
    if (savedAccounts) { accounts = JSON.parse(savedAccounts); } 
    else { accounts = {}; }

    // Load Teams
    let savedTeams = localStorage.getItem('emb_teams_v1');
    if (savedTeams) teams = JSON.parse(savedTeams);

    // MIGRATION SCRIPT (v3 -> v4 Multitenancy)
    let savedWorkersV3 = localStorage.getItem('embroidery_workers_v3');
    if (savedWorkersV3 && !savedTeams) {
        console.log("Migrating V3 data to V4 Multi-Team structure...");
        let oldWorkers = JSON.parse(savedWorkersV3);
        let oldSettings = JSON.parse(localStorage.getItem('embroidery_settings_v3') || '{}');
        let oldAtt = JSON.parse(localStorage.getItem('embroidery_attendance_v3') || '{}');

        let firstOwner = Object.keys(accounts)[0];
        if(!firstOwner) {
            firstOwner = 'boss_legacy';
            accounts[firstOwner] = { password: 'password', company: 'Migrated Data' };
        }
        let defaultTeamId = 'team_' + generateId();
        
        teams = {};
        teams[defaultTeamId] = {
            id: defaultTeamId,
            name: (accounts[firstOwner] && accounts[firstOwner].company) ? accounts[firstOwner].company : 'Legacy Team',
            owner: firstOwner,
            partners: []
        };

        workers = oldWorkers.map(w => ({ ...w, teamId: defaultTeamId }));
        
        settings = {};
        settings[defaultTeamId] = oldSettings;

        attendanceData = oldAtt;
        Object.keys(attendanceData).forEach(date => {
            Object.keys(attendanceData[date]).forEach(wId => {
                attendanceData[date][wId].teamId = defaultTeamId;
            });
        });

        localStorage.setItem('emb_teams_v1', JSON.stringify(teams));
        localStorage.setItem('emb_workers_v4', JSON.stringify(workers));
        localStorage.setItem('emb_settings_v4', JSON.stringify(settings));
        localStorage.setItem('emb_att_v4', JSON.stringify(attendanceData));
        
        localStorage.removeItem('embroidery_workers_v3');
    } else {
        // Standard V4 Load
        settings = JSON.parse(localStorage.getItem('emb_settings_v4')) || {};
        workers = JSON.parse(localStorage.getItem('emb_workers_v4')) || [];
        attendanceData = JSON.parse(localStorage.getItem('emb_att_v4')) || {};
    }
}

function saveData() {
    localStorage.setItem('embroidery_accounts', JSON.stringify(accounts));
    localStorage.setItem('emb_teams_v1', JSON.stringify(teams));
    localStorage.setItem('emb_settings_v4', JSON.stringify(settings));
    localStorage.setItem('emb_workers_v4', JSON.stringify(workers));
    localStorage.setItem('emb_att_v4', JSON.stringify(attendanceData));

    if (firebaseActive && currentTeamId) {
        syncToCloudBackground();
    }
}

let _syncTimeout = null;
function syncToCloudBackground() {
    const statusIcon = document.getElementById('cloud-status-icon');
    if (statusIcon) {
        statusIcon.className = 'cloud-status-icon syncing';
        statusIcon.title = "Syncing with Cloud...";
    }
    
    clearTimeout(_syncTimeout);
    _syncTimeout = setTimeout(async () => {
        try {
            if (!currentTeamId) return;
            
            // Sync settings
            const mySettings = settings[currentTeamId] || { machineTypes: [], festivals: [], autoProductionBonus: true };
            await db.ref(`settings/${currentTeamId}`).set(mySettings);
            
            // Sync workers
            const myWorkers = workers.filter(w => w.teamId === currentTeamId);
            await db.ref(`workers/${currentTeamId}`).set(myWorkers);
            
            // Sync attendance (isolate this team's records)
            const myAtt = {};
            Object.keys(attendanceData).forEach(date => {
                if (attendanceData[date]) {
                    Object.keys(attendanceData[date]).forEach(wId => {
                        const rec = attendanceData[date][wId];
                        if (rec && rec.teamId === currentTeamId) {
                            if (!myAtt[date]) myAtt[date] = {};
                            myAtt[date][wId] = rec;
                        }
                    });
                }
            });
            await db.ref(`attendance/${currentTeamId}`).set(myAtt);
            
            // Register/verify team in root collection
            if (teams[currentTeamId]) {
                await db.ref(`teams/${currentTeamId}`).set(teams[currentTeamId]);
            }
            
            if (statusIcon) {
                statusIcon.className = 'cloud-status-icon online';
                statusIcon.innerHTML = `<i class="fas fa-cloud"></i>`;
                statusIcon.title = "Cloud Synced";
            }
            console.log("Background cloud sync successful.");
        } catch (err) {
            console.error("Cloud sync background error:", err);
            if (statusIcon) {
                statusIcon.className = 'cloud-status-icon offline';
                statusIcon.innerHTML = `<i class="fas fa-cloud-slash"></i>`;
                statusIcon.title = "Cloud Sync Offline";
            }
        }
    }, 1000);
}

async function pullCloudUpdatesBackground() {
    if (!firebaseActive || !currentTeamId) return;
    
    const statusIcon = document.getElementById('cloud-status-icon');
    if (statusIcon) {
        statusIcon.className = 'cloud-status-icon syncing';
        statusIcon.title = "Syncing from cloud...";
    }
    
    try {
        const tId = currentTeamId;
        let changed = false;
        
        // 1. Settings
        const settingsSnap = await db.ref(`settings/${tId}`).once('value');
        if (settingsSnap.exists()) {
            settings[tId] = settingsSnap.val();
            changed = true;
        }
        
        // 2. Workers
        const workersSnap = await db.ref(`workers/${tId}`).once('value');
        if (workersSnap.exists()) {
            const cloudWorkers = workersSnap.val();
            let workersArr = [];
            if (Array.isArray(cloudWorkers)) {
                workersArr = cloudWorkers.filter(Boolean);
            } else if (typeof cloudWorkers === 'object' && cloudWorkers !== null) {
                workersArr = Object.values(cloudWorkers);
            }
            workers = workers.filter(w => w.teamId !== tId).concat(workersArr);
            changed = true;
        }
        
        // 3. Attendance
        const attSnap = await db.ref(`attendance/${tId}`).once('value');
        if (attSnap.exists()) {
            const cloudAtt = attSnap.val() || {};
            Object.keys(cloudAtt).forEach(date => {
                if (!attendanceData[date]) attendanceData[date] = {};
                Object.keys(cloudAtt[date]).forEach(wId => {
                    attendanceData[date][wId] = cloudAtt[date][wId];
                });
            });
            changed = true;
        }
        
        if (changed) {
            localStorage.setItem('emb_settings_v4', JSON.stringify(settings));
            localStorage.setItem('emb_workers_v4', JSON.stringify(workers));
            localStorage.setItem('emb_att_v4', JSON.stringify(attendanceData));
            
            // Re-render whichever view is currently active in the UI
            const activeView = document.querySelector('.view.active');
            if (activeView) {
                const id = activeView.id;
                if (id === 'view-workers') renderWorkers();
                else if (id === 'view-attendance') renderAttendance();
                else if (id === 'view-settings') renderSettings();
                else if (id === 'view-reports') renderReports();
            }
            console.log("Background cloud pull completed. UI refreshed.");
        }
        
        if (statusIcon) {
            statusIcon.className = 'cloud-status-icon online';
            statusIcon.innerHTML = `<i class="fas fa-cloud"></i>`;
            statusIcon.title = "Cloud Synced";
        }
    } catch (err) {
        console.error("Background pull error:", err);
        if (statusIcon) {
            statusIcon.className = 'cloud-status-icon offline';
            statusIcon.innerHTML = `<i class="fas fa-cloud-slash"></i>`;
            statusIcon.title = "Could not sync (Offline)";
        }
    }
}

// Data Isolation Helpers
function getMySettings() {
    if(!settings[currentTeamId]) settings[currentTeamId] = { machineTypes: [], festivals: [], autoProductionBonus: true };
    if(!settings[currentTeamId].machineTypes) settings[currentTeamId].machineTypes = [];
    if(!settings[currentTeamId].festivals) settings[currentTeamId].festivals = [];
    if(settings[currentTeamId].autoProductionBonus === undefined) settings[currentTeamId].autoProductionBonus = true;
    return settings[currentTeamId];
}
function getMyWorkers() {
    return workers.filter(w => w.teamId === currentTeamId);
}

window.determineTeamAndShowApp = function(username) {
    const userTeams = Object.values(teams).filter(t => t.owner === username || t.partners.includes(username));
    const err = document.getElementById('auth-error');
    if (userTeams.length > 0) {
        currentTeamId = userTeams[0].id;
        currentUserRole = userTeams[0].owner === username ? 'owner' : 'partner';
        err.innerText = '';
        
        renderWorkers();
        renderSettings();
        
        showMainApp();

        if (firebaseActive) {
            pullCloudUpdatesBackground();
        }
    } else {
        err.innerText = 'You are not part of any team. Access Denied.';
        localStorage.removeItem('embroidery_activeUser');
        currentUser = null;
    }
};

function setupEventListeners() {
    let currentAuthTab = 'login';
    
    document.querySelectorAll('.auth-tab').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.auth-tab').forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            currentAuthTab = e.currentTarget.getAttribute('data-tab');
            
            if (currentAuthTab === 'signup') {
                document.getElementById('signup-fields').style.display = 'block';
                document.getElementById('auth-submit-btn').innerText = 'Sign Up';
            } else {
                document.getElementById('signup-fields').style.display = 'none';
                document.getElementById('auth-submit-btn').innerText = 'Login';
            }
        });
    });

    document.getElementById('auth-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const user = document.getElementById('username').value.trim();
        const pass = document.getElementById('password').value;
        const err = document.getElementById('auth-error');
        err.innerText = '';
        
        if (!user || !pass) { err.innerText = 'Please fill in all fields.'; return; }
        
        const submitBtn = document.getElementById('auth-submit-btn');
        const origBtnText = submitBtn.innerText;
        submitBtn.disabled = true;
        submitBtn.innerText = currentAuthTab === 'signup' ? 'Signing Up...' : 'Logging In...';

        try {
            if (currentAuthTab === 'signup') {
                const company = document.getElementById('company-name').value.trim();
                if (!company) { throw new Error('Please enter a business name.'); }
                if (pass.length < 4) { throw new Error('Password must be at least 4 characters.'); }
                
                if (firebaseActive) {
                    const snap = await db.ref(`accounts/${user}`).once('value');
                    if (snap.exists()) { throw new Error('Username already exists.'); }
                } else {
                    if (accounts[user]) { throw new Error('Username already exists.'); }
                }
                
                accounts[user] = { password: pass, company: company || 'My Embroidery' };
                let newTeamId = 'team_' + generateId();
                teams[newTeamId] = { id: newTeamId, name: accounts[user].company, owner: user, partners: [] };
                settings[newTeamId] = { machineTypes: [], festivals: [], autoProductionBonus: true };
                
                if (firebaseActive) {
                    await db.ref(`accounts/${user}`).set({ password: pass, company: company });
                    await db.ref(`teams/${newTeamId}`).set(teams[newTeamId]);
                    await db.ref(`settings/${newTeamId}`).set(settings[newTeamId]);
                }
                
                saveData();
                currentUser = user;
                localStorage.setItem('embroidery_activeUser', currentUser);
                determineTeamAndShowApp(user);
            } else {
                let verified = false;
                let fetchedCompany = '';
                
                if (firebaseActive) {
                    const snap = await db.ref(`accounts/${user}`).once('value');
                    if (snap.exists()) {
                        const cloudAcct = snap.val();
                        if (cloudAcct && cloudAcct.password === pass) {
                            verified = true;
                            fetchedCompany = cloudAcct.company;
                            accounts[user] = cloudAcct;
                        }
                    }
                } else {
                    if (accounts[user] && accounts[user].password === pass) {
                        verified = true;
                        fetchedCompany = accounts[user].company;
                    }
                }
                
                if (!verified) { throw new Error('Invalid username or password.'); }
                
                currentUser = user;
                localStorage.setItem('embroidery_activeUser', currentUser);
                
                if (firebaseActive) {
                    showToast('Syncing your data from cloud...', 1500);
                    
                    const teamsSnap = await db.ref('teams').once('value');
                    let foundTeam = null;
                    if (teamsSnap.exists()) {
                        const allTeams = teamsSnap.val();
                        Object.values(allTeams).forEach(t => {
                            if (t && (t.owner === user || (t.partners && t.partners.includes(user)))) {
                                foundTeam = t;
                                teams[t.id] = t;
                            }
                        });
                    }
                    
                    if (foundTeam) {
                        const tId = foundTeam.id;
                        
                        const settingsSnap = await db.ref(`settings/${tId}`).once('value');
                        if (settingsSnap.exists()) {
                            settings[tId] = settingsSnap.val();
                        }
                        
                        const workersSnap = await db.ref(`workers/${tId}`).once('value');
                        if (workersSnap.exists()) {
                            const cloudWorkers = workersSnap.val();
                            let workersArr = [];
                            if (Array.isArray(cloudWorkers)) {
                                workersArr = cloudWorkers.filter(Boolean);
                            } else if (typeof cloudWorkers === 'object' && cloudWorkers !== null) {
                                workersArr = Object.values(cloudWorkers);
                            }
                            workers = workers.filter(w => w.teamId !== tId).concat(workersArr);
                        }
                        
                        const attSnap = await db.ref(`attendance/${tId}`).once('value');
                        if (attSnap.exists()) {
                            const cloudAtt = attSnap.val() || {};
                            Object.keys(cloudAtt).forEach(date => {
                                if (!attendanceData[date]) attendanceData[date] = {};
                                Object.keys(cloudAtt[date]).forEach(wId => {
                                    attendanceData[date][wId] = cloudAtt[date][wId];
                                });
                            });
                        }
                        
                        saveData();
                    }
                }
                
                determineTeamAndShowApp(user);
            }
        } catch (error) {
            err.innerText = error.message;
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerText = origBtnText;
        }
    });

    document.getElementById('logout-btn').addEventListener('click', () => {
        if (confirm('Are you sure you want to logout?')) {
            localStorage.removeItem('embroidery_activeUser');
            window.location.reload();
        }
    });

    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            
            const targetId = e.currentTarget.getAttribute('data-target');
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById(targetId).classList.add('active');

            const titles = {
                'view-workers': 'Team',
                'view-attendance': 'Daily Tracker',
                'view-settings': 'Configuration',
                'view-reports': 'Payroll & Flow'
            };
            document.getElementById('header-title').innerText = titles[targetId] || 'Dashboard';

            if (targetId === 'view-attendance') renderAttendance();
            else if (targetId === 'view-workers') renderWorkers();
            else if (targetId === 'view-settings') renderSettings();
            else if (targetId === 'view-reports') renderReports();
        });
    });

    setupPdfExportModal();

    // Worker Search
    const workerSearchEl = document.getElementById('worker-search');
    if (workerSearchEl) {
        workerSearchEl.addEventListener('input', (e) => {
            workerSearchQuery = e.target.value.trim().toLowerCase();
            renderWorkers();
        });
    }

    // Attendance Search
    const attSearchEl = document.getElementById('attendance-search');
    if (attSearchEl) {
        attSearchEl.addEventListener('input', (e) => {
            attendanceSearchQuery = e.target.value.trim().toLowerCase();
            renderAttendance();
        });
    }

    // Modals
    document.getElementById('add-worker-btn').addEventListener('click', () => {
        const mySettings = getMySettings();
        if(mySettings.machineTypes.length === 0) {
            showToast('Please configure Machine Types in Settings first.');
            return;
        }
        document.getElementById('worker-form').reset();
        document.getElementById('worker-id').value = '';
        document.getElementById('worker-machines-count').value = 1;
        generateWorkerMachineInputs(1, []);
        document.getElementById('worker-modal-title').innerText = 'Add Worker';
        document.getElementById('worker-modal').classList.add('active');
    });

    document.getElementById('close-worker-modal').addEventListener('click', () => document.getElementById('worker-modal').classList.remove('active'));
    document.getElementById('worker-form').addEventListener('submit', (e) => { e.preventDefault(); saveWorker(); });

    document.getElementById('add-machine-type-btn').addEventListener('click', () => {
        document.getElementById('machine-type-form').reset();
        document.getElementById('mt-id').value = '';
        document.getElementById('mt-modal-title').innerText = 'Add Machine Type';
        document.getElementById('machine-type-modal').classList.add('active');
    });

    document.getElementById('close-mt-modal').addEventListener('click', () => document.getElementById('machine-type-modal').classList.remove('active'));
    document.getElementById('machine-type-form').addEventListener('submit', (e) => { e.preventDefault(); saveMachineType(); });

    document.getElementById('add-festival-btn').addEventListener('click', () => {
        const date = document.getElementById('new-festival-date').value;
        const mySettings = getMySettings();
        if (!date) { showToast('Please select a date.'); return; }
        if (mySettings.festivals.includes(date)) { showToast('This date is already marked as a festival.'); return; }
        mySettings.festivals.push(date);
        mySettings.festivals.sort();
        saveData();
        renderSettings();
        if (currentDate === date) renderAttendance();
        document.getElementById('new-festival-date').value = '';
        showToast('Festival holiday added');
    });

    document.getElementById('attendance-date').addEventListener('change', (e) => {
        currentDate = e.target.value;
        renderAttendance();
    });

    const printBtn = document.getElementById('print-payroll-btn');
    if (printBtn) printBtn.addEventListener('click', openPdfExportModal);
}

window.showToast = function(message, durationMs) {
    const toast = document.getElementById('app-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(() => toast.classList.remove('show'), durationMs || 3200);
};

function setupPdfExportModal() {
    const modal = document.getElementById('pdf-export-modal');
    const form = document.getElementById('pdf-export-form');
    const scopeSel = document.getElementById('pdf-worker-scope');
    const workerWrap = document.getElementById('pdf-worker-select-wrap');
    if (!modal || !form) return;

    const close = () => {
        modal.classList.remove('active');
        const loading = document.getElementById('pdf-export-loading');
        const formEl = document.getElementById('pdf-export-form');
        if (loading) loading.style.display = 'none';
        if (formEl) formEl.style.display = 'block';
    };

    document.getElementById('close-pdf-export-modal')?.addEventListener('click', close);
    document.getElementById('pdf-export-cancel-btn')?.addEventListener('click', close);

    scopeSel?.addEventListener('change', () => {
        if (workerWrap) workerWrap.style.display = scopeSel.value === 'specific' ? 'block' : 'none';
    });

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        generatePayrollPdf();
    });
}

function openPdfExportModal() {
    const modal = document.getElementById('pdf-export-modal');
    if (!modal) return;

    const reportMonth = document.getElementById('report-month')?.value || currentDate.substring(0, 7);
    const [y, m] = reportMonth.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const fromStr = `${reportMonth}-01`;
    const toStr = `${reportMonth}-${String(lastDay).padStart(2, '0')}`;

    const fromInput = document.getElementById('pdf-from-date');
    const toInput = document.getElementById('pdf-to-date');
    if (fromInput) { fromInput.value = fromStr; fromInput.max = currentDate; }
    if (toInput) { toInput.value = toStr; toInput.max = currentDate; }

    const workerSel = document.getElementById('pdf-worker-id');
    const myWorkers = getMyWorkers();
    if (workerSel) {
        workerSel.innerHTML = myWorkers.map(w =>
            `<option value="${w.id}">${w.name}</option>`
        ).join('');
    }

    document.getElementById('pdf-export-form').style.display = 'block';
    document.getElementById('pdf-export-loading').style.display = 'none';
    modal.classList.add('active');
}

function generatePayrollPdf() {
    const fromDate = document.getElementById('pdf-from-date').value;
    const toDate = document.getElementById('pdf-to-date').value;
    const scope = document.getElementById('pdf-worker-scope').value;
    const workerId = document.getElementById('pdf-worker-id').value;

    if (!fromDate || !toDate) {
        showToast('Please select a valid date range');
        return;
    }
    if (fromDate > toDate) {
        showToast('From date must be before or equal to To date');
        return;
    }
    if (scope === 'specific' && !workerId) {
        showToast('Please select a worker');
        return;
    }

    const formEl = document.getElementById('pdf-export-form');
    const loading = document.getElementById('pdf-export-loading');
    if (formEl) formEl.style.display = 'none';
    if (loading) loading.style.display = 'flex';

    const filterId = scope === 'specific' ? workerId : null;

    setTimeout(() => {
        try {
            const myWorkers = getMyWorkers();
            const mySettings = getMySettings();
            const teamAttendance = getTeamAttendanceData();
            const reportData = getPayrollReportData(
                myWorkers, teamAttendance, mySettings, fromDate, toDate, filterId
            );

            const result = PdfExport.generate(reportData);

            if (result.error) {
                showToast(result.error);
            } else {
                showToast('PDF exported successfully');
                document.getElementById('pdf-export-modal').classList.remove('active');
            }
        } catch (err) {
            console.error(err);
            showToast('Failed to generate PDF. Please try again.');
        } finally {
            if (formEl) formEl.style.display = 'block';
            if (loading) loading.style.display = 'none';
        }
    }, 120);
}

function showMainApp() {
    document.getElementById('auth-screen').classList.remove('active');
    document.getElementById('app-content-screen').classList.add('active');
    if(teams[currentTeamId]) {
        document.getElementById('header-title').innerText = teams[currentTeamId].name || 'Dashboard';
    }
}

function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }

/* =========================================================
   DEBOUNCE — used for stitch input to prevent DOM thrashing
   ========================================================= */
function debounce(fn, ms) {
    let timer;
    return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), ms);
    };
}

const debouncedSave = debounce(() => saveData(), 600);

/* --- SETTINGS: Machine Types & Teams --- */
function saveMachineType() {
    const nameVal = document.getElementById('mt-name').value.trim();
    if (!nameVal) { showToast('Please enter a machine name.'); return; }
    
    const id = document.getElementById('mt-id').value || generateId();
    const mt = {
        id,
        name: nameVal,
        defaultAvg: parseInt(document.getElementById('mt-avg').value) || 0,
        threshold: parseInt(document.getElementById('mt-thresh').value) || 0,
        bonusAmount: parseInt(document.getElementById('mt-bonus').value) || 0
    };
    
    const mySettings = getMySettings();
    const idx = mySettings.machineTypes.findIndex(x => x.id === id);
    if (idx > -1) mySettings.machineTypes[idx] = mt;
    else mySettings.machineTypes.push(mt);
    
    saveData();
    document.getElementById('machine-type-modal').classList.remove('active');
    renderSettings();
    showToast('Machine type saved');
}

window.editMachineType = function(id) {
    const mySettings = getMySettings();
    const mt = mySettings.machineTypes.find(x => x.id === id);
    if (!mt) return;
    document.getElementById('mt-id').value = mt.id;
    document.getElementById('mt-name').value = mt.name;
    document.getElementById('mt-modal-title').innerText = 'Edit Machine Type';
    document.getElementById('machine-type-modal').classList.add('active');
}

window.deleteMachineType = function(id) {
    if (confirm('Delete this machine type? Workers using it may be affected.')) {
        const mySettings = getMySettings();
        mySettings.machineTypes = mySettings.machineTypes.filter(x => x.id !== id);
        saveData();
        renderSettings();
        showToast('Machine type deleted');
    }
}

window.deleteFestival = function(date) {
    const mySettings = getMySettings();
    mySettings.festivals = mySettings.festivals.filter(d => d !== date);
    saveData();
    renderSettings();
    if (currentDate === date) renderAttendance();
    showToast('Festival removed');
}

function renderSettings() {
    const mySettings = getMySettings();

    const mtContainer = document.getElementById('machine-types-container');
    mtContainer.innerHTML = '';
    
    if (mySettings.machineTypes.length === 0) {
        mtContainer.innerHTML = '<p style="color:var(--text-muted); font-size:0.88rem;">No machine types configured yet.</p>';
    }
    
    mySettings.machineTypes.forEach(mt => {
        mtContainer.innerHTML += `
            <div class="machine-row" style="margin-bottom:0.5rem; display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <div style="font-weight:700; color:var(--text-main); font-size:1.05rem;">${escapeHtml(mt.name)}</div>
                    <div style="font-size:0.78rem; color:var(--text-muted);">Production bonus: global slab rules</div>
                </div>
                <div style="display:flex; gap:0.5rem;">
                    <button class="btn-icon edit" onclick="editMachineType('${mt.id}')" style="width:30px; height:30px;"><i class="fas fa-pen" style="font-size:0.8rem"></i></button>
                    <button class="btn-icon delete" onclick="deleteMachineType('${mt.id}')" style="width:30px; height:30px;"><i class="fas fa-trash" style="font-size:0.8rem"></i></button>
                </div>
            </div>
        `;
    });

    const fContainer = document.getElementById('festivals-container');
    fContainer.innerHTML = '';
    
    if (mySettings.festivals.length === 0) {
        fContainer.innerHTML = '<p style="color:var(--text-muted); font-size:0.88rem;">No festival holidays added yet.</p>';
    }
    
    mySettings.festivals.forEach(f => {
        const dateObj = new Date(f + 'T00:00:00');
        const formatted = dateObj.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
        fContainer.innerHTML += `<span class="badge" style="background: #ecfdf5; color:#064e3b; border: 1px solid #10b981; padding:0.4rem 0.8rem; display:flex; align-items:center; gap:0.5rem; border-radius: 20px;">${formatted} <i class="fas fa-times" style="cursor:pointer; opacity:0.7;" onclick="deleteFestival('${f}')"></i></span>`;
    });

    const autoBonusCb = document.getElementById('auto-production-bonus');
    if (autoBonusCb) {
        autoBonusCb.checked = isAutoProductionBonusEnabled(mySettings);
        autoBonusCb.onchange = () => {
            mySettings.autoProductionBonus = autoBonusCb.checked;
            saveData();
            if (document.getElementById('view-attendance').classList.contains('active')) renderAttendance();
            showToast(autoBonusCb.checked ? 'Auto bonus enabled' : 'Manual bonus mode enabled');
        };
    }
}

/* --- WORKER ALLOCATION --- */
window.generateWorkerMachineInputs = function(forceCount = null, existingMachines = []) {
    const mySettings = getMySettings();
    const inputCount = document.getElementById('worker-machines-count').value;
    const count = forceCount !== null ? forceCount : parseInt(inputCount) || 1;
    const container = document.getElementById('worker-machine-details-container');
    container.innerHTML = '';
    
    for (let i = 0; i < count; i++) {
        const prev = existingMachines[i] || { mtId: mySettings.machineTypes[0]?.id || '', salary: '' };
        
        let selHtml = mySettings.machineTypes.map(mt => `<option value="${mt.id}" ${mt.id === prev.mtId ? 'selected' : ''}>${escapeHtml(mt.name)}</option>`).join('');

        const html = `
            <div class="machine-row worker-machine-slot">
                <div class="machine-row-title">Machine Slot ${i+1}</div>
                <div class="input-group-vertical" style="margin-bottom:0.8rem">
                    <label>Machine Type Config</label>
                    <select class="glass-input slot-mt-id" required style="background:rgba(0,0,0,0.02)">${selHtml}</select>
                </div>
                <div class="input-group-vertical" style="margin-bottom:0">
                    <label>Fixed Monthly Salary (for this slot)</label>
                    <input type="number" class="glass-input slot-salary" value="${prev.salary}" required min="0" placeholder="e.g. 15000">
                </div>
            </div>
        `;
        container.innerHTML += html;
    }
}

function saveWorker() {
    const nameVal = document.getElementById('worker-name').value.trim();
    const phoneVal = document.getElementById('worker-phone').value.trim();
    const joinDateVal = document.getElementById('worker-join-date').value;
    
    // Validation
    if (!nameVal) { showToast('Please enter worker name.'); return; }
    if (!/^[0-9]{10}$/.test(phoneVal)) { showToast('Phone number must be exactly 10 digits.'); return; }
    if (!joinDateVal) { showToast('Please select a joining date.'); return; }
    
    const id = document.getElementById('worker-id').value || generateId();
    
    const mtIds = document.querySelectorAll('.slot-mt-id');
    const salaries = document.querySelectorAll('.slot-salary');
    const machines = [];
    let hasInvalidSalary = false;
    
    for(let i=0; i<mtIds.length; i++) {
        const sal = parseInt(salaries[i].value) || 0;
        if (sal <= 0) { hasInvalidSalary = true; }
        machines.push({ mtId: mtIds[i].value, salary: sal });
    }
    
    if (hasInvalidSalary) { showToast('Please enter a valid salary for each machine slot.'); return; }

    const worker = {
        id,
        teamId: currentTeamId,
        name: nameVal,
        phone: phoneVal,
        joinDate: joinDateVal,
        machines: machines
    };

    const index = workers.findIndex(w => w.id === id);
    if (index > -1) workers[index] = worker;
    else workers.push(worker);

    saveData();
    document.getElementById('worker-modal').classList.remove('active');
    renderWorkers();
    showToast(index > -1 ? 'Worker updated' : 'Worker added');
}

window.editWorker = function(id) {
    const worker = getMyWorkers().find(w => w.id === id);
    if (!worker) return;

    document.getElementById('worker-id').value = worker.id;
    document.getElementById('worker-name').value = worker.name;
    document.getElementById('worker-phone').value = worker.phone;
    document.getElementById('worker-join-date').value = worker.joinDate;
    
    document.getElementById('worker-machines-count').value = worker.machines.length;
    generateWorkerMachineInputs(worker.machines.length, worker.machines);
    
    document.getElementById('worker-modal-title').innerText = 'Edit Worker';
    document.getElementById('worker-modal').classList.add('active');
}

window.deleteWorker = function(id) {
    if (confirm('Are you sure you want to remove this team member?')) {
        workers = workers.filter(w => w.id !== id);
        saveData();
        renderWorkers();
        showToast('Worker removed');
    }
}

function renderWorkers() {
    const container = document.getElementById('worker-list-container');
    container.innerHTML = '';

    let myWorkers = getMyWorkers();
    
    // Apply search filter
    if (workerSearchQuery) {
        myWorkers = myWorkers.filter(w => w.name.toLowerCase().includes(workerSearchQuery));
    }

    if (myWorkers.length === 0 && !workerSearchQuery) {
        container.innerHTML = '<div class="empty-state"><i class="fas fa-users"></i><p>Your team is empty. Add a worker to get started.</p></div>';
        return;
    }
    
    if (myWorkers.length === 0 && workerSearchQuery) {
        container.innerHTML = '<div class="no-results"><i class="fas fa-search"></i><p>No workers matching "' + escapeHtml(workerSearchQuery) + '"</p></div>';
        return;
    }

    const mySettings = getMySettings();

    myWorkers.forEach((w, idx) => {
        let totalSalary = 0;
        let badgesHtml = '';
        w.machines.forEach(m => {
            totalSalary += m.salary;
            const mt = mySettings.machineTypes.find(x => x.id === m.mtId);
            badgesHtml += `<span class="badge">${mt ? escapeHtml(mt.name) : 'Unknown'}</span>`;
        });

        const salaryFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(totalSalary).replace('₹', '₹ ');
        
        const card = document.createElement('div');
        card.className = 'worker-card';
        card.style.animationDelay = `${idx * 0.04}s`;
        card.innerHTML = `
            <div class="worker-header">
                <div>
                    <div class="worker-name">${escapeHtml(w.name)}</div>
                    <div class="badge-container">${badgesHtml}</div>
                </div>
            </div>
            <div class="worker-details">
                <div><i class="fas fa-phone" style="width:20px; opacity:0.5"></i> ${escapeHtml(w.phone)}</div>
                <div><i class="fas fa-calendar" style="width:20px; opacity:0.5"></i> Joined: ${new Date(w.joinDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
            </div>
            <div class="total-salary">Total Salary: ${salaryFmt}/mo</div>
            <div class="worker-actions">
                <button class="btn-icon edit" onclick="editWorker('${w.id}')"><i class="fas fa-pen"></i></button>
                <button class="btn-icon delete" onclick="deleteWorker('${w.id}')"><i class="fas fa-trash"></i></button>
            </div>
        `;
        container.appendChild(card);
    });
}

/* =========================================================
   ATTENDANCE — with FIXED stitch input (no focus loss)
   ========================================================= */
let expandedWorkers = {};

function renderAttendance() {
    const container = document.getElementById('attendance-list-container');
    const festBanner = document.getElementById('festival-banner');
    container.innerHTML = '';
    
    const mySettings = getMySettings();
    let myWorkers = getMyWorkers();
    
    // Apply search filter
    if (attendanceSearchQuery) {
        myWorkers = myWorkers.filter(w => w.name.toLowerCase().includes(attendanceSearchQuery));
    }

    const isFestival = mySettings.festivals.includes(currentDate);
    festBanner.style.display = isFestival ? 'block' : 'none';
    
    // Show/hide bulk actions
    const bulkBar = document.getElementById('bulk-actions-bar');
    if (bulkBar) bulkBar.style.display = isFestival ? 'none' : 'flex';

    if (getMyWorkers().length === 0) {
        container.innerHTML = '<div class="empty-state"><i class="fas fa-bolt"></i><p>No workers available. Add workers in the Team tab.</p></div>';
        return;
    }
    
    if (myWorkers.length === 0 && attendanceSearchQuery) {
        container.innerHTML = '<div class="no-results"><i class="fas fa-search"></i><p>No workers matching "' + escapeHtml(attendanceSearchQuery) + '"</p></div>';
        return;
    }

    if (!attendanceData[currentDate]) attendanceData[currentDate] = {};
    const todayData = attendanceData[currentDate];

    const autoBonus = isAutoProductionBonusEnabled(mySettings);
    let totalStitches = 0;
    let totalComputedBaseWages = 0;
    let totalCustomBonuses = 0;
    let totalMachineBonuses = 0;
    let presentCount = 0;
    let absentCount = 0;

    myWorkers.forEach(w => {
        let defaultData = { status: 'absent', prod: {}, customBonus: 0, photo: null, teamId: currentTeamId };
        if (isFestival) defaultData.status = 'festival';
        
        const data = todayData[w.id] || defaultData;
        const s = data.status;
        const dayEarn = calculateDayEarnings(w, currentDate, data, mySettings);

        let machineInputsHtml = '';
        const totalWorkerBonus = dayEarn.perfBonus;
        const workerDailyBase = dayEarn.baseSalary + dayEarn.festivalPay;
        const dayStitches = dayEarn.totalStitches;
        totalStitches += dayStitches;
        
        if (s === 'full' || s === 'half') presentCount++;
        else if (s === 'absent') absentCount++;

        // BUG FIX: Use onblur + debounced oninput that does NOT re-render
        if (s === 'full' || s === 'half') {
            w.machines.forEach((m, index) => {
                const mt = mySettings.machineTypes.find(x => x.id === m.mtId) || null;
                if (!mt) return;
                const machineStitches = data.prod ? (data.prod[index] || 0) : 0;
                
                // Color hint based on stitch total
                machineInputsHtml += `
                    <div class="machine-row">
                        <div class="machine-row-title">${escapeHtml(mt.name)} (Slot ${index+1})</div>
                        <div class="stitch-input-wrap">
                            <label style="font-size:0.8rem; font-weight:600; color:var(--text-secondary); margin-bottom:0.3rem; display:block;">Stitches Produced</label>
                            <input type="number" class="glass-input" 
                                   id="stitch-${w.id}-${index}"
                                   value="${machineStitches || ''}" 
                                   placeholder="0" inputmode="numeric"
                                   oninput="handleStitchInput('${w.id}', ${index}, this.value)"
                                   onblur="handleStitchBlur('${w.id}', ${index}, this.value)">
                            <div class="stitch-hint" id="stitch-hint-${w.id}-${index}"></div>
                        </div>
                    </div>
                `;
            });
        }

        totalMachineBonuses += totalWorkerBonus;
        totalComputedBaseWages += dayEarn.baseSalary + dayEarn.festivalPay;
        totalCustomBonuses += dayEarn.customBonus;

        const bonusPanel = (s === 'full' || s === 'half') ? `
            <div class="production-bonus-panel" id="bonus-panel-${w.id}">
                <div><span class="prod-bonus-label">Total Stitches</span> <strong id="bonus-stitches-${w.id}">${dayStitches.toLocaleString('en-IN')}</strong></div>
                <div><span class="prod-bonus-label">Slab</span> <span class="prod-bonus-slab" id="bonus-slab-${w.id}">${dayEarn.bonusSlab}</span></div>
                <div><span class="prod-bonus-label">Auto Bonus</span> <strong class="prod-bonus-amt" id="bonus-amt-${w.id}">${formatINR(dayEarn.perfBonus, 2)}</strong></div>
            </div>
        ` : '';

        const manualBonusBlock = !autoBonus ? `
            <div class="input-group-vertical" style="margin-top:0.75rem">
                <label>Manual Bonus (₹)</label>
                <input type="number" class="glass-input" value="${data.customBonus || ''}" placeholder="0" onblur="updateCustomBonus('${w.id}', this.value)">
            </div>
        ` : '';
        const customBonusFmt = (!autoBonus && data.customBonus) ? `<div style="color:var(--success); font-size:0.85rem; margin-top:0.25rem;"><i class="fas fa-gift"></i> Manual Bonus: ₹${data.customBonus}</div>` : '';

        let statusButtons = `
            <div class="attendance-status">
                <button class="status-btn present ${s==='full'?'active':''}" onclick="markAtt('${w.id}', 'full')">Full Day</button>
                <button class="status-btn present ${s==='half'?'active':''}" style="${s==='half'?'background: #fffbeb; border-color: var(--warning); color: var(--warning);':''}" onclick="markAtt('${w.id}', 'half')">Half Day</button>
                <button class="status-btn absent ${s==='absent'?'active':''}" onclick="markAtt('${w.id}', 'absent')">Absent</button>
            </div>
        `;

        if (isFestival) {
            statusButtons = `
                <div class="attendance-status">
                    <div class="status-btn active" style="background:#ecfdf5; border-color:var(--success); color:#064e3b; font-weight:700; width:100%; text-align:center;">
                        <i class="fas fa-gift"></i> Festival Auto-Paid
                    </div>
                </div>
            `;
        }

        const detailsDisplay = expandedWorkers[w.id] ? 'block' : 'none';
        const chevron = expandedWorkers[w.id] ? 'fa-chevron-up' : 'fa-chevron-down';
        
        let statusTag = '';
        if(s === 'full') statusTag = '<span style="color:#064e3b; font-size:0.78rem; font-weight:700">Full</span>';
        else if(s === 'half') statusTag = '<span style="color:#92400e; font-size:0.78rem; font-weight:700">Half</span>';
        else if(s === 'absent') statusTag = '<span style="color:#991b1b; font-size:0.78rem; font-weight:700">Absent</span>';
        else if(s === 'festival') statusTag = '<span style="color:#064e3b; font-size:0.78rem; font-weight:700">Fest</span>';

        let cardClass = 'attendance-card worker-card';
        if(s === 'full') cardClass += ' present-full';
        else if(s === 'half') cardClass += ' present-half';
        else if(s === 'absent') cardClass += ' absent';
        else if(s === 'festival') cardClass += ' festival';

        const card = document.createElement('div');
        card.className = cardClass;
        card.innerHTML = `
            <div class="worker-header" style="margin-bottom:0; cursor:pointer;" onclick="toggleAttDetails('${w.id}')">
                <div style="display:flex; align-items:center; justify-content:space-between; width:100%;">
                    <div>
                        <span class="worker-name">${escapeHtml(w.name)} ${statusTag ? `(${statusTag})` : ''}</span>
                        <div style="font-size:0.82rem; color:var(--text-muted); margin-top:2px;">${formatINRPlain(dayEarn.total)} payout · ${dayStitches.toLocaleString('en-IN')} stitches</div>
                    </div>
                    <div>
                        <i class="fas ${chevron}" style="color:var(--text-muted)"></i>
                    </div>
                </div>
            </div>
            
            <div id="att-details-${w.id}" style="display:${detailsDisplay}; margin-top:1rem; border-top:1px solid var(--border); padding-top:1rem;">
                ${statusButtons}

                ${(s === 'full' || s === 'half') ? `
                    ${bonusPanel}
                    ${manualBonusBlock}
                    ${customBonusFmt}

                    <div style="margin-top:1rem;">
                        ${machineInputsHtml}
                    </div>
                ` : ''}
            </div>
        `;
        container.appendChild(card);
    });

    // Daily Summary Card — inserted at top
    const sumCard = document.createElement('div');
    sumCard.className = 'daily-summary';
    sumCard.innerHTML = `
        <h3><i class="fas fa-chart-bar" style="color:var(--primary); margin-right:0.4rem;"></i> Daily Summary</h3>
        <div class="summary-grid">
            <div class="summary-item">
                <div class="summary-label">Base Wages</div>
                <div class="summary-value">₹${Math.round(totalComputedBaseWages).toLocaleString('en-IN')}</div>
            </div>
            <div class="summary-item">
                <div class="summary-label">Bonus</div>
                <div class="summary-value">₹${Math.round(totalMachineBonuses).toLocaleString('en-IN')}</div>
            </div>
            <div class="summary-item">
                <div class="summary-label">Present</div>
                <div class="summary-value">${presentCount}/${myWorkers.length}</div>
            </div>
            ${totalCustomBonuses > 0 ? `
            <div class="summary-item">
                <div class="summary-label">Manual</div>
                <div class="summary-value">₹${Math.round(totalCustomBonuses).toLocaleString('en-IN')}</div>
            </div>` : ''}
            <div class="summary-total">
                <div class="summary-label">Total Payout</div>
                <div class="summary-value">₹${Math.round(totalComputedBaseWages+totalMachineBonuses+totalCustomBonuses).toLocaleString('en-IN')}</div>
            </div>
        </div>
    `;
    container.insertBefore(sumCard, container.firstChild);
}

window.toggleAttDetails = function(workerId) {
    expandedWorkers[workerId] = !expandedWorkers[workerId];
    renderAttendance();
};

window.markAtt = function(workerId, status) {
    if (!attendanceData[currentDate]) attendanceData[currentDate] = {};
    if (!attendanceData[currentDate][workerId]) attendanceData[currentDate][workerId] = { status: 'absent', prod: {}, customBonus: 0, photo: null, teamId: currentTeamId };
    
    attendanceData[currentDate][workerId].status = status;
    attendanceData[currentDate][workerId].teamId = currentTeamId;
    if (status === 'absent') { attendanceData[currentDate][workerId].prod = {}; attendanceData[currentDate][workerId].customBonus = 0; }
    
    // Auto-expand the worker on status change
    expandedWorkers[workerId] = (status !== 'absent');
    
    saveData(); renderAttendance();
};

/* =========================================================
   STITCH INPUT — BUG FIX
   Save data inline without destroying DOM / losing focus.
   Re-render only on blur if needed.
   ========================================================= */
window.handleStitchInput = function(workerId, mIdx, rawValue) {
    // 1. Save to data model (no DOM rebuild)
    if (!attendanceData[currentDate]) attendanceData[currentDate] = {};
    if (!attendanceData[currentDate][workerId]) {
        attendanceData[currentDate][workerId] = { status: 'full', prod: {}, customBonus: 0, photo: null, teamId: currentTeamId };
    }
    if (!attendanceData[currentDate][workerId].prod) attendanceData[currentDate][workerId].prod = {};
    attendanceData[currentDate][workerId].prod[mIdx] = parseInt(rawValue) || 0;
    
    if (isAutoProductionBonusEnabled(getMySettings())) {
        attendanceData[currentDate][workerId].customBonus = 0;
    }

    // 2. Update bonus panel inline (targeted DOM update — no re-render!)
    updateBonusPanelInline(workerId);

    // 3. Debounced save to localStorage
    debouncedSave();
};

window.handleStitchBlur = function(workerId, mIdx, rawValue) {
    // Final save on blur
    if (!attendanceData[currentDate]) attendanceData[currentDate] = {};
    if (!attendanceData[currentDate][workerId]) {
        attendanceData[currentDate][workerId] = { status: 'full', prod: {}, customBonus: 0, photo: null, teamId: currentTeamId };
    }
    if (!attendanceData[currentDate][workerId].prod) attendanceData[currentDate][workerId].prod = {};
    attendanceData[currentDate][workerId].prod[mIdx] = parseInt(rawValue) || 0;
    
    if (isAutoProductionBonusEnabled(getMySettings())) {
        attendanceData[currentDate][workerId].customBonus = 0;
    }
    
    saveData();
    
    // Update the summary card and header info without losing focus
    updateDailySummary();
};

function updateBonusPanelInline(workerId) {
    const data = attendanceData[currentDate]?.[workerId];
    if (!data) return;
    
    const worker = getMyWorkers().find(w => w.id === workerId);
    if (!worker) return;
    
    const mySettings = getMySettings();
    const dayEarn = calculateDayEarnings(worker, currentDate, data, mySettings);
    
    // Update bonus panel elements by ID (no DOM rebuild!)
    const stitchesEl = document.getElementById(`bonus-stitches-${workerId}`);
    const slabEl = document.getElementById(`bonus-slab-${workerId}`);
    const amtEl = document.getElementById(`bonus-amt-${workerId}`);
    
    if (stitchesEl) stitchesEl.textContent = dayEarn.totalStitches.toLocaleString('en-IN');
    if (slabEl) slabEl.textContent = dayEarn.bonusSlab;
    if (amtEl) amtEl.textContent = formatINR(dayEarn.perfBonus, 2);
    
    // Update stitch hints
    worker.machines.forEach((m, index) => {
        const hintEl = document.getElementById(`stitch-hint-${workerId}-${index}`);
        if (hintEl) {
            const stitches = data.prod?.[index] || 0;
            if (stitches > 0) {
                hintEl.textContent = stitches.toLocaleString('en-IN') + ' stitches';
                hintEl.className = 'stitch-hint';
            } else {
                hintEl.textContent = '';
            }
        }
    });
}

function updateDailySummary() {
    // Recalculate and update the summary card without full re-render
    const mySettings = getMySettings();
    let myWorkers = getMyWorkers();
    if (attendanceSearchQuery) {
        myWorkers = myWorkers.filter(w => w.name.toLowerCase().includes(attendanceSearchQuery));
    }
    
    const todayData = attendanceData[currentDate] || {};
    const isFestival = mySettings.festivals.includes(currentDate);
    let totalStitches = 0, totalBase = 0, totalBonus = 0, totalCustom = 0;
    
    myWorkers.forEach(w => {
        let defaultData = { status: 'absent', prod: {}, customBonus: 0, teamId: currentTeamId };
        if (isFestival) defaultData.status = 'festival';
        const data = todayData[w.id] || defaultData;
        const dayEarn = calculateDayEarnings(w, currentDate, data, mySettings);
        totalStitches += dayEarn.totalStitches;
        totalBase += dayEarn.baseSalary + dayEarn.festivalPay;
        totalBonus += dayEarn.perfBonus;
        totalCustom += dayEarn.customBonus;
    });
    
    // Update summary card if it exists
    const summaryEl = document.querySelector('.daily-summary');
    if (summaryEl) {
        const vals = summaryEl.querySelectorAll('.summary-value');
        if (vals[0]) vals[0].textContent = '₹' + Math.round(totalBase).toLocaleString('en-IN');
        if (vals[1]) vals[1].textContent = '₹' + Math.round(totalBonus).toLocaleString('en-IN');
    }
}

// Keep old updateProd for backward compatibility but redirect to new handler
window.updateProd = function(workerId, mIdx, stitches) {
    handleStitchInput(workerId, mIdx, stitches);
};

window.updateCustomBonus = function(workerId, val) {
    attendanceData[currentDate][workerId].customBonus = parseInt(val) || 0;
    saveData(); renderAttendance();
};

/* --- BULK ATTENDANCE --- */
window.bulkMarkAttendance = function(status) {
    const myWorkers = getMyWorkers();
    const mySettings = getMySettings();
    if (mySettings.festivals.includes(currentDate)) { showToast('Cannot bulk mark on festival days.'); return; }
    if (myWorkers.length === 0) { showToast('No workers to mark.'); return; }
    
    const label = status === 'full' ? 'Present (Full Day)' : 'Absent';
    if (!confirm(`Mark all ${myWorkers.length} workers as ${label} for ${currentDate}?`)) return;
    
    if (!attendanceData[currentDate]) attendanceData[currentDate] = {};
    
    myWorkers.forEach(w => {
        if (!attendanceData[currentDate][w.id]) {
            attendanceData[currentDate][w.id] = { status: 'absent', prod: {}, customBonus: 0, photo: null, teamId: currentTeamId };
        }
        attendanceData[currentDate][w.id].status = status;
        attendanceData[currentDate][w.id].teamId = currentTeamId;
        if (status === 'absent') {
            attendanceData[currentDate][w.id].prod = {};
            attendanceData[currentDate][w.id].customBonus = 0;
        }
    });
    
    saveData();
    renderAttendance();
    showToast(`All workers marked as ${label}`);
};

/* --- DATA BACKUP & RESTORE --- */
window.exportBackup = function() {
    const backup = {
        version: DB_VERSION,
        exportedAt: new Date().toISOString(),
        accounts,
        teams,
        settings,
        workers,
        attendanceData
    };
    
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `emb-backup-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Backup exported successfully');
};

window.importBackup = function(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const backup = JSON.parse(e.target.result);
            
            if (!backup.version || !backup.accounts) {
                showToast('Invalid backup file.');
                return;
            }
            
            if (!confirm('This will replace ALL current data with the backup. Are you sure?')) return;
            
            accounts = backup.accounts || {};
            teams = backup.teams || {};
            settings = backup.settings || {};
            workers = backup.workers || [];
            attendanceData = backup.attendanceData || {};
            
            saveData();
            showToast('Backup restored! Reloading...');
            setTimeout(() => window.location.reload(), 1500);
        } catch (err) {
            console.error('Import error:', err);
            showToast('Failed to read backup file. Make sure it is a valid JSON file.');
        }
    };
    reader.readAsText(file);
    
    // Reset input so same file can be selected again
    event.target.value = '';
};

/* --- PAYROLL REPORTS --- */
function getTeamAttendanceData() {
    const teamAttendance = {};
    Object.keys(attendanceData).forEach(date => {
        teamAttendance[date] = {};
        Object.keys(attendanceData[date]).forEach(wId => {
            const rec = attendanceData[date][wId];
            if (!rec.teamId || rec.teamId === currentTeamId) teamAttendance[date][wId] = rec;
        });
    });
    return teamAttendance;
}

function renderReports() {
    const container = document.getElementById('reports-list-container');
    container.innerHTML = '';
    
    const myWorkers = getMyWorkers();
    if (myWorkers.length === 0) {
        container.innerHTML = '<div class="empty-state"><i class="fas fa-file-invoice-dollar"></i><p>No workers available. Add workers first.</p></div>';
        return;
    }

    const reportMonth = document.getElementById('report-month').value;
    if (!reportMonth) return;
    const reportYear = reportMonth.substring(0, 4);
    const [y, m] = reportMonth.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const fromStr = `${reportMonth}-01`;
    const toStr = `${reportMonth}-${String(lastDay).padStart(2, '0')}`;

    const mySettings = getMySettings();
    const teamAtt = getTeamAttendanceData();
    const monthReport = getPayrollReportData(myWorkers, teamAtt, mySettings, fromStr, toStr, null);

    let siteYearTotal = 0;
    const yearFrom = `${reportYear}-01-01`;
    const yearTo = `${reportYear}-12-31`;
    const yearReport = getPayrollReportData(myWorkers, teamAtt, mySettings, yearFrom, yearTo, null);
    siteYearTotal = yearReport.summary.overallExpense;

    // Month name for display
    const monthNames = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const monthDisplay = monthNames[m] + ' ' + y;

    monthReport.workerReports.forEach(wr => {
        const yearWr = yearReport.workerReports.find(x => x.workerId === wr.workerId);
        const yearEarned = yearWr ? yearWr.totalSalary : 0;
        const fmtMonth = formatINR(wr.totalSalary).replace('₹', '₹ ');
        const fmtYear = formatINR(yearEarned).replace('₹', '₹ ');

        const card = document.createElement('div');
        card.className = 'worker-card';
        card.innerHTML = `
            <div class="worker-header" style="margin-bottom:0.5rem">
                <span class="worker-name">${escapeHtml(wr.name)}</span>
            </div>
            <div class="report-breakdown">
                <div><span class="report-lbl">Salary</span><strong>${formatINRPlain(wr.salaryPart)}</strong></div>
                <div><span class="report-lbl">Bonus</span><strong>${formatINRPlain(wr.bonusPart)}</strong></div>
                <div><span class="report-lbl">Stitches</span><strong>${wr.totalStitches.toLocaleString('en-IN')}</strong></div>
            </div>
            <div style="font-size:0.82rem; color:var(--text-muted); margin: 0.75rem 0 0.2rem;">Total Payout (${monthDisplay}):</div>
            <div style="font-size:1.35rem; color:var(--primary); font-weight:800; margin-bottom: 1rem;">${fmtMonth}</div>
            <div style="font-size:0.78rem; color:var(--text-muted); border-top:1px dashed var(--border); padding-top:0.5rem;">
                Year-To-Date (${reportYear}): <strong style="color:var(--text-main)">${fmtYear}</strong>
            </div>
        `;
        container.appendChild(card);
    });

    const s = monthReport.summary;
    const sumCard = document.createElement('div');
    sumCard.className = 'daily-summary';
    sumCard.style.marginTop = '1.5rem';
    sumCard.innerHTML = `
        <h3><i class="fas fa-building" style="color:var(--primary); margin-right:0.4rem;"></i> Facility Rollup (${monthDisplay})</h3>
        <div class="summary-grid">
            <div class="summary-item">
                <div class="summary-label">Salary</div>
                <div class="summary-value">${formatINRPlain(s.totalSalaryPaid)}</div>
            </div>
            <div class="summary-item">
                <div class="summary-label">Bonus</div>
                <div class="summary-value">${formatINRPlain(s.totalBonusPaid)}</div>
            </div>
            <div class="summary-total">
                <div>
                    <div class="summary-label">Total Payout (Month)</div>
                    <div class="summary-value">${formatINRPlain(s.overallExpense)}</div>
                </div>
            </div>
        </div>
        <div style="font-size:0.78rem; color:var(--text-muted); margin-top:0.75rem; border-top:1px solid rgba(99,102,241,0.1); padding-top:0.5rem;">
            YTD ${reportYear}: <strong style="color:var(--text-main)">${formatINRPlain(siteYearTotal)}</strong>
        </div>
    `;
    container.insertBefore(sumCard, container.firstChild);
}

/* --- UTILITY --- */
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

/* --- OFFLINE CACHE --- */
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('Service Worker Registered!', reg.scope))
            .catch(err => console.error('Service Worker Registration Failed:', err));
    });
}
