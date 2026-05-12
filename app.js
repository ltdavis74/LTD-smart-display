class SmartDisplay {
    constructor() {
        this.currentCard = 0;
        this.photos = [];
        this.currentPhotoIndex = 0;
        this.photoInterval = null;
        this.settings = this.loadSettings();
        this.summaryShown = false;
        this.lastSummaryDate = new Date().toDateString();
        
        // Cache DOM elements for better performance
        this.domCache = {};
        this.cacheDOMElements();
        
        // Performance optimization flags
        this.isLowPowerMode = this.detectLowPowerMode();
        this.lastUpdateTime = 0;
        this.lastTimeBarUpdate = 0;
        this.updateThrottle = 1000; // 1 second throttle for updates
        
        // Navigation control flags
        this.carouselNavigationDisabled = false;
        this.swipeEventsDisabled = false;

        // Calendar grid view state
        this.calendarViewMode = 'day';       // 'day' | 'week' | 'month'
        this.calendarMonthDate = new Date(); // which month the month grid is showing
        this.calendarDayDate   = new Date(); // which day the day view is showing (default: today)
        this.calendarWeekStart = null;       // Sunday of the week the week view is showing (set in setupCalendarGrid)
        this.calendarMonthEvents = [];       // cached events for the currently displayed month/window
        this.calendarAutoReturnTimer = null;
        this.CALENDAR_AUTO_RETURN_MS = 60000; // 60 s inactivity → back to Day(today) then Card 0

        // Radar state
        this._radarReady          = false;
        this._radarMap            = null;
        this._radarHost           = 'https://tilecache.rainviewer.com';
        this._radarFrames         = [];
        this._radarLayers         = [];
        this._radarIdx            = 0;
        this._radarPlaying        = true;
        this._radarTimer          = null;
        this._radarRefreshTimer   = null;
        this._radarLastFetch      = 0;

        this.init();
    }

    cacheDOMElements() {
        // Cache frequently accessed DOM elements
        this.domCache = {
            carouselWrapper: document.getElementById('carouselWrapper'),
            calendarCard: document.getElementById('calendarCard'),
            calendarContent: document.getElementById('calendarContent'),
            leftTouchArea: document.getElementById('leftTouchArea'),
            rightTouchArea: document.getElementById('rightTouchArea'),
            photoSlideshow: document.getElementById('photoSlideshow'),
            photoInfoOverlay: document.getElementById('photoInfoOverlay'),
            photoInfoTitle:   document.getElementById('photoInfoTitle'),
            photoInfoPath:    document.getElementById('photoInfoPath'),
            timeDisplay: document.querySelector('.time'),
            dateDisplay: document.querySelector('.date'),
            weatherDisplay: document.getElementById('weatherDisplay'),
            temperature: document.querySelector('.temperature'),
            condition: document.querySelector('.condition'),
            weatherIcon: document.querySelector('.weather-icon i'),
            wxHourlyStrip: document.getElementById('wxHourlyStrip'),
            wxDailyStrip: document.getElementById('wxDailyStrip'),
            agendaContent: document.getElementById('agendaContent'),
            summaryContent: document.getElementById('summaryContent'),
            groceryList: document.getElementById('groceryList'),
            costcoList: document.getElementById('costcoList'),
            tasksList: document.getElementById('tasksList'),
            homeAssistantFrame: document.getElementById('homeAssistantFrame'),
            settingsModal: document.getElementById('settingsModal')
        };
    }

    detectLowPowerMode() {
        // Detect if running on low-power device (Raspberry Pi)
        return navigator.hardwareConcurrency <= 4 || 
               navigator.deviceMemory <= 4 ||
               /arm|aarch64/i.test(navigator.platform);
    }

    init() {
        // Ensure carousel starts at Card 0 regardless of any class set in index.html
        this.domCache.carouselWrapper.classList.remove(
            'slide-left', 'slide-left-2', 'slide-left-3', 'slide-left-4'
        );
        this.setupEventListeners();
        try {
            this.setupCalendarGrid(); // inject month/day view UI into Card 4
        } catch (e) {
            // Non-fatal — calendar grid enhancement fails gracefully; core display still runs
            console.error('setupCalendarGrid failed (non-fatal):', e);
        }
        this.updateTime();
        this.loadCalendarEvents();
        this.loadWeather();
        this.loadPhotos();
        this.loadLists();
        this.loadTasks();

        // Optimize intervals based on power mode
        const intervals = this.isLowPowerMode ? {
            time: 2000,           // 2 seconds instead of 1
            weather: 45 * 60 * 1000,  // 45 minutes instead of 30
            calendar: 2 * 60 * 1000,  // 2 minutes instead of 1
            photos: 3 * 60 * 1000,    // 3 minutes instead of 1.5
            forecast: 20 * 60 * 1000, // 20 minutes instead of 15
            agenda: 20 * 60 * 1000,   // 20 minutes instead of 15
            summary: 30 * 1000        // 30 seconds instead of 10
        } : {
            time: 1000,
            weather: 30 * 60 * 1000,
            calendar: 60 * 1000,
            photos: 90 * 1000,
            forecast: 15 * 60 * 1000,
            agenda: 15 * 60 * 1000,
            summary: 60 * 1000 // Check every minute instead of every 10 seconds
        };
        
        // Update time with throttling
        setInterval(() => this.updateTime(), intervals.time);
        
        // Update weather less frequently
        setInterval(() => this.loadWeather(), intervals.weather);
        
        // Update calendar less frequently
        setInterval(() => this.loadCalendarEvents(), intervals.calendar);
        
        // Refresh photos less frequently
        setInterval(() => this.loadPhotos(), intervals.photos);
        
        // Load forecast and agenda initially
        this.loadForecast();
        this.loadAgenda();
        
        // Refresh forecast and agenda less frequently
        setInterval(() => this.loadForecast(), intervals.forecast);
        setInterval(() => this.loadAgenda(), intervals.agenda);
        setInterval(() => this.loadLists(), 60 * 1000);
        setInterval(() => this.loadTasks(), 5 * 60 * 1000);
        
        // Check for hourly summary less frequently
        this.checkHourlySummary();
        setInterval(() => this.checkHourlySummary(), intervals.summary);
        
        // Update time bars less frequently
        this.updateAllTimeBars();
        setInterval(() => this.updateAllTimeBars(), intervals.time);
        
        // Debounced resize handler
        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                if (this.domCache.calendarContent.children.length > 0) {
                    this.adjustCalendarCardHeight(this.domCache.calendarContent.children.length);
                }
            }, 250);
        });
    }

    setupEventListeners() {
        // Touch areas for swipe gestures
        this.domCache.leftTouchArea.addEventListener('click', () => this.previousCard());
        this.domCache.rightTouchArea.addEventListener('click', () => this.nextCard());

        // Wake-flash: panel TCON takes seconds to settle after backlight wake,
        // producing pale vertical banding. A full-screen white flash on the
        // wake-touch drives all source drivers to max simultaneously, which
        // both masks the artifact and tends to help the bias loop converge.
        const WAKE_IDLE_MS = 20000;
        const WAKE_FLASH_MS = 220;
        let lastInteractionAt = Date.now();
        const triggerWakeFlash = () => {
            const flash = document.createElement('div');
            flash.style.cssText =
                'position:fixed;inset:0;background:#fff;z-index:2147483647;pointer-events:none;';
            document.body.appendChild(flash);
            setTimeout(() => flash.remove(), WAKE_FLASH_MS);
        };
        const onPotentialWake = () => {
            const now = Date.now();
            if (now - lastInteractionAt > WAKE_IDLE_MS) triggerWakeFlash();
            lastInteractionAt = now;
        };
        document.addEventListener('touchstart', onPotentialWake, { capture: true, passive: true });
        document.addEventListener('mousedown', onPotentialWake, true);

        // Touch/swipe gestures with throttling
        let startX = 0;
        let endX = 0;
        let lastSwipeTime = 0;
        const swipeThrottle = 300; // Prevent rapid swipes

        document.addEventListener('touchstart', (e) => {
            startX = e.touches[0].clientX;
        });

        document.addEventListener('touchend', (e) => {
            endX = e.changedTouches[0].clientX;
            const now = Date.now();
            if (now - lastSwipeTime > swipeThrottle) {
                this.handleSwipe(startX, endX);
                lastSwipeTime = now;
            }
        });

        // Mouse drag for desktop with throttling
        let isDragging = false;
        let startPos = 0;
        let lastMouseSwipeTime = 0;

        document.addEventListener('mousedown', (e) => {
            isDragging = true;
            startPos = e.clientX;
        });

        document.addEventListener('mouseup', (e) => {
            if (isDragging) {
                const endPos = e.clientX;
                const now = Date.now();
                if (now - lastMouseSwipeTime > swipeThrottle) {
                    this.handleSwipe(startPos, endPos);
                    lastMouseSwipeTime = now;
                }
                isDragging = false;
            }
        });

        // Settings with event delegation
        document.addEventListener('click', (e) => {
            if (e.target.closest('.settings-btn')) {
                e.preventDefault();
                e.stopPropagation();
                this.openSettings();
            }
        });

        document.getElementById('closeSettings').addEventListener('click', () => this.closeSettings());
        document.getElementById('saveSettings').addEventListener('click', () => this.saveSettings());
        document.getElementById('refreshPage').addEventListener('click', () => this.refreshPage());
        document.getElementById('summaryRefreshBtn').addEventListener('click', () => this.refreshSummary());
        
        // Hourly forecast overlay
        document.getElementById('closeHourlyForecast').addEventListener('click', () => this.closeHourlyForecast());
        
        // Close overlay when clicking outside
        document.getElementById('hourlyForecastOverlay').addEventListener('click', (e) => {
            if (e.target.id === 'hourlyForecastOverlay') {
                this.closeHourlyForecast();
            }
        });
        
        // Prevent scroll events from propagating to background on Raspberry Pi
        document.getElementById('hourlyForecastOverlay').addEventListener('wheel', (e) => {
            e.stopPropagation();
        }, { passive: false });
        
        document.getElementById('hourlyForecastOverlay').addEventListener('touchmove', (e) => {
            e.stopPropagation();
        }, { passive: false });
        
        // Close settings when clicking outside
        document.getElementById('settingsModal').addEventListener('click', (e) => {
            if (e.target.id === 'settingsModal') {
                this.closeSettings();
            }
        });
        
        // Prevent scroll events from propagating to background on Raspberry Pi
        document.getElementById('settingsModal').addEventListener('wheel', (e) => {
            e.stopPropagation();
        }, { passive: false });
        
        document.getElementById('settingsModal').addEventListener('touchmove', (e) => {
            e.stopPropagation();
        }, { passive: false });

        // Back buttons with event delegation
        document.addEventListener('click', (e) => {
            if (e.target.closest('.ha-back-btn')) {
                this.goToCard(0);
            }
            if (e.target.closest('.wx-dd-back')) {
                this.closeWxDayDetail();
            }
            if (e.target.closest('.wx-radar-back')) {
                this.closeRadar();
            }
        });

        // Keyboard navigation
        document.addEventListener('keydown', (e) => {
            if (this.carouselNavigationDisabled) return;
            
            switch(e.key) {
                case 'ArrowLeft':
                    this.previousCard();
                    break;
                case 'ArrowRight':
                    this.nextCard();
                    break;
                case 'Escape':
                    this.closeSettings();
                    this.closeHourlyForecast();
                    break;
            }
        });
    }

    handleSwipe(startX, endX) {
        if (this.swipeEventsDisabled) return;

        const threshold = 50;
        const diff = startX - endX;

        if (Math.abs(diff) > threshold) {
            if (this.currentCard === 4 && this.calendarViewMode === 'month') {
                // Swipe navigates months instead of carousel cards
                this.resetCalendarAutoReturn();
                if (diff > 0) {
                    this.navigateMonth(1);   // left swipe → next month
                } else {
                    this.navigateMonth(-1);  // right swipe → prev month
                }
            } else if (this.currentCard === 4 && this.calendarViewMode === 'day') {
                // Block carousel swipe in day view — user uses the Back button
                this.resetCalendarAutoReturn();
            } else {
                if (diff > 0) {
                    this.nextCard();
                } else {
                    this.previousCard();
                }
            }
        }
    }

    goToCard(index) {
        if (index === this.currentCard) return;

        // Navigating away from Card 3 — cancel weather auto-return, close day detail + radar
        if (this.currentCard === 3) {
            this.clearWeatherAutoReturn();
            const normal = document.getElementById('wxNormal');
            const detail = document.getElementById('wxDayDetail');
            if (normal) normal.style.display = '';
            if (detail) detail.classList.remove('visible');
            this.closeRadar();
        }

        // Navigating away from Card 4 — reset calendar to default (Day/today) for next entry
        if (this.currentCard === 4) {
            this.clearCalendarAutoReturn();
            this.calendarDayDate   = new Date();
            this.calendarWeekStart = this._weekStartFor(new Date());
        }

        // Navigating to Card 4 — show Day view (today) as default
        if (index === 4) {
            this.calendarDayDate   = new Date();
            this.calendarWeekStart = this._weekStartFor(new Date());
        }

        const wrapper = this.domCache.carouselWrapper;

        // Remove all slide classes
        wrapper.classList.remove('slide-left', 'slide-left-2', 'slide-left-3', 'slide-left-4');

        // Add appropriate slide class
        if (index === 1) {
            wrapper.classList.add('slide-left');
        } else if (index === 2) {
            wrapper.classList.add('slide-left-2');
        } else if (index === 3) {
            wrapper.classList.add('slide-left-3');
        } else if (index === 4) {
            wrapper.classList.add('slide-left-4');
        }

        this.currentCard = index;

        // Handle card-specific behavior
        if (index === 0) {
            // Photos card
            this.domCache.calendarCard.style.display = 'block';
            this.domCache.leftTouchArea.style.pointerEvents = 'auto';
            this.domCache.rightTouchArea.style.pointerEvents = 'auto';
        } else if (index === 1) {
            // Hourly Summary card
            this.domCache.calendarCard.style.display = 'none';
            this.domCache.leftTouchArea.style.pointerEvents = 'none';
            this.domCache.rightTouchArea.style.pointerEvents = 'none';
            this.loadSummary();
        } else if (index === 2) {
            // Home Assistant card
            this.domCache.calendarCard.style.display = 'none';
            this.domCache.leftTouchArea.style.pointerEvents = 'none';
            this.domCache.rightTouchArea.style.pointerEvents = 'none';
        } else if (index === 3) {
            // Weather Forecast card
            this.domCache.calendarCard.style.display = 'none';
            this.domCache.leftTouchArea.style.pointerEvents = 'none';
            this.domCache.rightTouchArea.style.pointerEvents = 'none';
            this.loadForecast();
            if (!this._wxPhotosInitialized) {
                this._wxPhotosInitialized = true;
                this.setupWeatherBackground();
            }
            this.startWeatherAutoReturn();
        } else if (index === 4) {
            // Calendar card — enter Day view (today) by default
            this.domCache.calendarCard.style.display = 'none';
            this.domCache.leftTouchArea.style.pointerEvents = 'none';
            this.domCache.rightTouchArea.style.pointerEvents = 'none';
            // Small delay lets the carousel CSS transition start before we flip the view
            setTimeout(() => this.showCalendarView('week'), 50);
        }
    }

    nextCard() {
        const nextIndex = (this.currentCard + 1) % 5;
        this.goToCard(nextIndex);
    }

    previousCard() {
        const prevIndex = this.currentCard === 0 ? 4 : this.currentCard - 1;
        this.goToCard(prevIndex);
    }

    updateTime() {
        const now = Date.now();
        if (now - this.lastUpdateTime < this.updateThrottle) return;
        this.lastUpdateTime = now;

        const timeElement = this.domCache.timeDisplay;
        const dateElement = this.domCache.dateDisplay;

        const currentTime = new Date();
        timeElement.textContent = currentTime.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });

        dateElement.textContent = currentTime.toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    }

    updateAllTimeBars() {
        const now = Date.now();
        if (now - this.lastTimeBarUpdate < this.updateThrottle) return;
        this.lastTimeBarUpdate = now;

        const timeString = new Date().toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });
        
        // Update all time displays in headers
        const headerTimeDisplays = document.querySelectorAll('.header-time-display');
        headerTimeDisplays.forEach(timeDisplay => {
            timeDisplay.textContent = timeString;
        });
    }

    async loadWeather() {
        try {
            if (!this.settings.latitude || !this.settings.longitude) {
                console.log('Weather coordinates not configured');
                return;
            }

            const response = await fetch(`/api/weather?lat=${this.settings.latitude}&lon=${this.settings.longitude}`);
            const weatherData = await response.json();

            if (weatherData.error) {
                console.error('Weather API error:', weatherData.error);
                return;
            }

            this.updateWeatherDisplay(weatherData);
        } catch (error) {
            console.error('Error loading weather:', error);
        }
    }

    updateWeatherDisplay(weatherData) {
        const tempElement = this.domCache.temperature;
        const conditionElement = this.domCache.condition;
        const iconElement = this.domCache.weatherIcon;

        tempElement.textContent = `${Math.round(weatherData.current.temperature_2m)}°F`;
        conditionElement.textContent = this.getWeatherDescription(weatherData.current.weather_code);

        const iconClass = this.getWeatherIcon(weatherData.current.weather_code);
        iconElement.className = `fas ${iconClass}`;
    }

    getWeatherIcon(code) {
        // Simplified weather icon mapping
        if (code === 0) return 'fa-sun weather-sunny';
        if (code >= 1 && code <= 3) return 'fa-cloud weather-cloudy';
        if (code >= 45 && code <= 48) return 'fa-cloud weather-foggy';
        if (code >= 51 && code <= 67) return 'fa-cloud-rain weather-rain';
        if (code >= 71 && code <= 77) return 'fa-snowflake weather-snow';
        if (code >= 80 && code <= 82) return 'fa-cloud-rain weather-rain';
        if (code >= 85 && code <= 86) return 'fa-snowflake weather-snow';
        if (code >= 95 && code <= 99) return 'fa-bolt weather-storm';
        return 'fa-cloud weather-cloudy';
    }

    getWeatherDescription(code) {
        const descriptions = {
            0: 'Clear sky',
            1: 'Partly cloudy',
            2: 'Partly cloudy',
            3: 'Overcast',
            45: 'Foggy',
            48: 'Depositing rime fog',
            51: 'Light drizzle',
            53: 'Moderate drizzle',
            55: 'Dense drizzle',
            56: 'Light freezing drizzle',
            57: 'Dense freezing drizzle',
            61: 'Slight rain',
            63: 'Moderate rain',
            65: 'Heavy rain',
            66: 'Light freezing rain',
            67: 'Heavy freezing rain',
            71: 'Slight snow',
            73: 'Moderate snow',
            75: 'Heavy snow',
            77: 'Snow grains',
            80: 'Slight rain showers',
            81: 'Moderate rain showers',
            82: 'Violent rain showers',
            85: 'Slight snow showers',
            86: 'Heavy snow showers',
            95: 'Thunderstorm',
            96: 'Thunderstorm with slight hail',
            99: 'Thunderstorm with heavy hail'
        };
        return descriptions[code] || 'Unknown';
    }

    getWindDirection(degrees) {
        const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
        const index = Math.round(degrees / 22.5) % 16;
        return directions[index];
    }

    getWindArrow(degrees) {
        return `<span class="wind-direction" style="transform: rotate(${degrees}deg);">→</span>`;
    }

    async loadCalendarEvents(retryCount = 0) {
        const MAX_RETRIES = 5;
        const RETRY_DELAY_MS = 2000;
        try {
            const response = await fetch('/api/calendar/events');
            if (response.status === 503) {
                if (retryCount < MAX_RETRIES) {
                    console.log(`Calendar events: server initializing, retry ${retryCount + 1}/${MAX_RETRIES} in ${RETRY_DELAY_MS/1000}s`);
                    setTimeout(() => this.loadCalendarEvents(retryCount + 1), RETRY_DELAY_MS);
                } else {
                    this.updateCalendarDisplay([]);
                }
                return;
            }
            const events = await response.json();
            this.updateCalendarDisplay(events);
        } catch (error) {
            console.error('Error loading calendar events:', error);
            if (retryCount < MAX_RETRIES) {
                setTimeout(() => this.loadCalendarEvents(retryCount + 1), RETRY_DELAY_MS);
            } else {
                this.updateCalendarDisplay([]);
            }
        }
    }

    async loadLists() {
        try {
            const res = await fetch('/api/lists');
            if (!res.ok) {
                // Sidecar down or not yet authed — leave existing content alone
                if (res.status === 503) this._renderListsUnavailable();
                return;
            }
            const data = await res.json();
            this.renderListCol(this.domCache.groceryList, data.grocery?.listId || null, data.grocery?.items || []);
            this.renderListCol(this.domCache.costcoList,  data.costco?.listId  || null, data.costco?.items  || []);
        } catch (e) {
            console.error('Error loading lists:', e);
        }
    }

    _renderListsUnavailable() {
        const msg = '<div class="tasks-empty">Keep service offline</div>';
        if (this.domCache.groceryList) this.domCache.groceryList.innerHTML = msg;
        if (this.domCache.costcoList)  this.domCache.costcoList.innerHTML  = msg;
    }

    async loadTasks() {
        try {
            const res = await fetch('/api/tasks');
            if (!res.ok) {
                if (this.domCache.tasksList)
                    this.domCache.tasksList.innerHTML = '<div class="tasks-empty">Tasks unavailable</div>';
                return;
            }
            const data = await res.json();
            this.renderTasksList(data.items || []);
        } catch (e) {
            console.error('Error loading tasks:', e);
        }
    }

    renderTasksList(items) {
        const el = this.domCache.tasksList;
        if (!el) return;
        if (!items.length) {
            el.innerHTML = '<div class="tasks-empty">All caught up</div>';
            return;
        }
        const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        el.innerHTML = items.map(it =>
            `<div class="task-item" data-task-id="${it.id}">` +
            `<span class="task-check"></span>` +
            `<span class="task-label">${esc(it.title)}</span>` +
            `</div>`
        ).join('');
        el.querySelectorAll('.task-item').forEach(item => {
            item.addEventListener('click', () =>
                this.completeTask(item.dataset.taskId, item)
            );
        });
    }

    completeTask(taskId, el) {
        el.classList.add('done');
        setTimeout(() => el.remove(), 400);
        fetch(`/api/tasks/${encodeURIComponent(taskId)}/complete`, { method: 'POST' })
            .catch(e => console.error('Failed to complete task:', e));
    }

    renderListCol(el, listId, items) {
        if (!el) return;
        if (!items.length) {
            el.innerHTML = '<div class="tasks-empty">Use OK Google to add an item</div>';
            return;
        }
        const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        el.innerHTML = items.map(it =>
            `<div class="task-item" data-item-id="${it.id}" data-list-id="${listId}">` +
            `<span class="task-check"></span>` +
            `<span class="task-label">${esc(it.text)}</span>` +
            `</div>`
        ).join('');
        el.querySelectorAll('.task-item').forEach(item => {
            item.addEventListener('click', () =>
                this.checkItem(item.dataset.listId, item.dataset.itemId, item)
            );
        });
    }

    checkItem(listId, itemId, el) {
        el.classList.add('done');
        setTimeout(() => el.remove(), 400);
        fetch(`/api/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}/check`, {
            method: 'POST',
        }).catch(e => console.error('Failed to check item:', e));
    }

    updateCalendarDisplay(events) {
        const calendarContent = this.domCache.calendarContent;
        const calendarCard = this.domCache.calendarCard;

        if (events.length === 0) {
            calendarContent.innerHTML = '<div class="loading">No upcoming events</div>';
            calendarCard.classList.add('collapsed');
            return;
        }

        calendarCard.classList.remove('collapsed');

        // Filter events: show all-day events for today (persistent), timed events for next 24 hours
        const now = new Date();
        
        const upcomingEvents = events.filter(event => {
            const endTime = new Date(event.end.dateTime || event.end.date);
            const startTime = new Date(event.start.dateTime || event.start.date);
            
            // For all-day events, show if they're today or tomorrow
            if (!event.start.dateTime) {
                const [year, month, day] = event.start.date.split('-').map(Number);
                const eventDate = new Date(year, month - 1, day);
                const today = new Date();
                const tomorrow = new Date(today);
                tomorrow.setDate(tomorrow.getDate() + 1);
                
                const eventDateString = eventDate.toDateString();
                const todayString = today.toDateString();
                const tomorrowString = tomorrow.toDateString();
                
                return eventDateString === todayString || eventDateString === tomorrowString;
            }
            
            // For timed events, show if they start within the next 24 hours and haven't ended yet
            const next24Hours = new Date(now.getTime() + (24 * 60 * 60 * 1000));
            return startTime <= next24Hours && endTime > now;
        });
        
        if (upcomingEvents.length === 0) {
            calendarContent.innerHTML = '<div class="loading">No upcoming events</div>';
            calendarCard.classList.add('collapsed');
            return;
        }
        
        const sortedEvents = upcomingEvents.sort((a, b) => {
            const aStart = new Date(a.start.dateTime || a.start.date);
            const aEnd = new Date(a.end.dateTime || a.end.date);
            const bStart = new Date(b.start.dateTime || b.start.date);
            const bEnd = new Date(b.end.dateTime || b.end.date);
            
            const aIsCurrent = now >= aStart && now <= aEnd;
            const bIsCurrent = now >= bStart && now <= bEnd;
            const aIsAllDay = !a.start.dateTime;
            const bIsAllDay = !b.start.dateTime;
            
            // All-day events first
            if (aIsAllDay && !bIsAllDay) return -1;
            if (!aIsAllDay && bIsAllDay) return 1;
            
            // Then current events
            if (aIsCurrent && !bIsCurrent) return -1;
            if (!aIsCurrent && bIsCurrent) return 1;
            
            // Finally by start time
            return aStart - bStart;
        });

        const eventsHtml = sortedEvents.slice(0, 5).map(event => {
            const startTime = new Date(event.start.dateTime || event.start.date);
            const endTime = new Date(event.end.dateTime || event.end.date);
            const isAllDay = !event.start.dateTime;
            
            let timeString;
            let eventClass = 'event-item';
            let statusText = '';
            
            if (isAllDay) {
                timeString = 'All day';
                eventClass += ' all-day-event';
                
                const today = new Date();
                const [year, month, day] = event.start.date.split('-').map(Number);
                const eventDate = new Date(year, month - 1, day);
                const tomorrow = new Date(today);
                tomorrow.setDate(tomorrow.getDate() + 1);
                
                const eventDateString = eventDate.toDateString();
                const todayString = today.toDateString();
                const tomorrowString = tomorrow.toDateString();
                
                if (eventDateString === todayString) {
                    eventClass += ' current-event';
                    statusText = '<div class="event-status">Today</div>';
                } else if (eventDateString === tomorrowString) {
                    statusText = '<div class="event-status tomorrow-status">Tomorrow</div>';
                }
            } else {
                const duration = Math.round((endTime - startTime) / (1000 * 60));
                const durationText = duration < 60 ? `${duration}m` : `${Math.round(duration / 60)}h ${duration % 60}m`;
                
                timeString = startTime.toLocaleTimeString('en-US', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: true
                });
                
                if (now >= startTime && now <= endTime) {
                    eventClass += ' current-event';
                    const remainingTime = Math.round((endTime - now) / (1000 * 60));
                    const remainingText = remainingTime < 60 ? `${remainingTime}m left` : `${Math.round(remainingTime / 60)}h ${remainingTime % 60}m left`;
                    statusText = `<div class="event-status">${remainingText}</div>`;
                }
                
                timeString += ` (${durationText})`;
            }

            let locationHtml = '';
            if (event.location) {
                locationHtml = `<div class="event-location">📍 ${event.location}</div>`;
            }

            return `
                <div class="${eventClass}">
                    <div class="event-time">${timeString}</div>
                    <div class="event-title">${event.summary}</div>
                    ${statusText}
                    ${locationHtml}
                </div>
            `;
        }).join('');

        calendarContent.innerHTML = eventsHtml;
        this.adjustCalendarCardHeight(sortedEvents.length);
    }

    adjustCalendarCardHeight(eventCount) {
        const calendarCard = this.domCache.calendarCard;
        const calendarContent = this.domCache.calendarContent;
        
        if (eventCount === 0) {
            calendarCard.classList.add('collapsed');
            return;
        }
        
        calendarCard.classList.remove('collapsed');
        
        // Simplified height calculation
        calendarContent.style.maxHeight = 'none';
        calendarContent.style.overflowY = 'visible';
        calendarCard.style.height = 'auto';
        
        const actualContentHeight = calendarContent.scrollHeight;
        const headerHeight = 60;
        const padding = 32;
        const actualCardHeight = headerHeight + actualContentHeight + padding;
        
        const viewportHeight = window.innerHeight;
        const maxAllowedHeight = viewportHeight * 0.7;
        
        if (actualCardHeight > maxAllowedHeight) {
            calendarCard.style.height = `${maxAllowedHeight}px`;
            calendarContent.style.maxHeight = `${maxAllowedHeight - headerHeight - padding}px`;
            calendarContent.style.overflowY = 'auto';
        } else {
            calendarCard.style.height = 'auto';
            calendarContent.style.maxHeight = 'none';
            calendarContent.style.overflowY = 'visible';
        }
    }

    async loadPhotos() {
        try {
            const query = this.settings.photoQuery || 'nature landscape';
            const response = await fetch(`/api/photos/${encodeURIComponent(query)}`);
            const data = await response.json();

            if (data.error) {
                console.error('Photos API error:', data.error);
                return;
            }

            const newPhotos = data.mediaItems || [];
            
            // Only restart slideshow if photos actually changed
            if (JSON.stringify(this.photos) !== JSON.stringify(newPhotos)) {
                this.photos = newPhotos;
                this.currentPhotoIndex = 0;
                this.startPhotoSlideshow();
                console.log('Photos refreshed:', this.photos.length, 'images loaded');
            }
        } catch (error) {
            console.error('Error loading photos:', error);
        }
    }

    startPhotoSlideshow() {
        if (this.photos.length === 0) return;

        const slideshowContainer = this.domCache.photoSlideshow;

        // Preserve the ambient shortcuts container — innerHTML = '' would destroy it
        const ambientShortcuts = slideshowContainer.querySelector('.ambient-shortcuts');
        slideshowContainer.innerHTML = '';

        // Create photo slides with optimized loading
        this.photos.forEach((photo, index) => {
            const slide = document.createElement('div');
            slide.className = `photo-slide ${index === 0 ? 'active' : ''}`;
            
            // Plex proxy handles transcoding to display resolution server-side
            const imageUrl = photo.baseUrl;
            slide.style.backgroundImage = `url(${imageUrl})`;
            
            // Add photographer attribution
            if (photo.photographer && photo.photographerUrl) {
                const attribution = document.createElement('div');
                attribution.className = 'photo-attribution';
                attribution.innerHTML = `
                    <a href="${photo.photographerUrl}" target="_blank" rel="noopener noreferrer">
                        Photo by ${photo.photographer}
                    </a>
                `;
                slide.appendChild(attribution);
            }
            
            slideshowContainer.appendChild(slide);
        });

        // Re-append the shortcuts container after slides are rebuilt
        if (ambientShortcuts) slideshowContainer.appendChild(ambientShortcuts);

        // Start slideshow with longer interval for better performance
        const slideInterval = this.isLowPowerMode ? 120000 : 60000; // 2 minutes vs 1 minute
        this.photoInterval = setInterval(() => {
            this.nextPhoto();
        }, slideInterval);
    }

    nextPhoto() {
        if (this.photos.length === 0) return;

        const slides = document.querySelectorAll('.photo-slide');
        slides[this.currentPhotoIndex].classList.remove('active');

        this.currentPhotoIndex = (this.currentPhotoIndex + 1) % this.photos.length;
        slides[this.currentPhotoIndex].classList.add('active');
    }

    showPhotoInfo() {
        const photo = this.photos[this.currentPhotoIndex];
        if (!photo || !this.domCache.photoInfoOverlay) return;

        this.domCache.photoInfoTitle.textContent = photo.filename || 'Unknown';

        const parts = ['Photos'];
        if (photo.year)  parts.push(photo.year);
        if (photo.album) parts.push(photo.album);
        this.domCache.photoInfoPath.textContent = parts.join(' › ');

        this.domCache.photoInfoOverlay.classList.add('visible');

        clearTimeout(this._photoInfoTimer);
        this._photoInfoTimer = setTimeout(() => this.hidePhotoInfo(), 12000);
    }

    hidePhotoInfo() {
        clearTimeout(this._photoInfoTimer);
        if (this.domCache.photoInfoOverlay)
            this.domCache.photoInfoOverlay.classList.remove('visible');
    }

    openSettings() {
        this.domCache.settingsModal.classList.add('active');
        this.populateSettingsForm();
        
        // Disable carousel navigation
        this.disableCarouselNavigation();
    }

    closeSettings() {
        this.domCache.settingsModal.classList.remove('active');
        
        // Re-enable carousel navigation
        this.enableCarouselNavigation();
    }

    populateSettingsForm() {
        document.getElementById('photoQuery').value = this.settings.photoQuery || 'nature landscape';
        document.getElementById('haUrl').value = this.settings.haUrl || '';
        document.getElementById('latitude').value = this.settings.latitude || '';
        document.getElementById('longitude').value = this.settings.longitude || '';
        document.getElementById('summaryEnabled').value = this.settings.summaryEnabled ? 'true' : 'false';
        document.getElementById('summaryTime').value = this.settings.summaryTime || '08:00';
        document.getElementById('userName').value = this.settings.userName || '';
    }

    saveSettings() {
        const newSettings = {
            photoQuery: document.getElementById('photoQuery').value,
            haUrl: document.getElementById('haUrl').value,
            latitude: parseFloat(document.getElementById('latitude').value),
            longitude: parseFloat(document.getElementById('longitude').value),
            summaryEnabled: document.getElementById('summaryEnabled').value === 'true',
            summaryTime: document.getElementById('summaryTime').value,
            userName: document.getElementById('userName').value
        };

        this.settings = { ...this.settings, ...newSettings };
        localStorage.setItem('smartDisplaySettings', JSON.stringify(this.settings));

        // Update Home Assistant iframe if URL changed
        if (newSettings.haUrl) {
            this.domCache.homeAssistantFrame.src = newSettings.haUrl;
        }

        // Reload data if settings changed
        if (newSettings.photoQuery) {
            this.loadPhotos();
        }
        if (newSettings.latitude && newSettings.longitude) {
            this.loadWeather();
        }

        // Reset summary shown flag if settings changed
        this.summaryShown = false;
        console.log('Settings saved, summary will show at:', this.settings.summaryTime);

        this.closeSettings();
    }

    async loadForecast() {
        try {
            if (!this.settings.latitude || !this.settings.longitude) {
                console.log('Weather coordinates not configured');
                return;
            }

            const response = await fetch(`/api/weather?lat=${this.settings.latitude}&lon=${this.settings.longitude}`);
            const weatherData = await response.json();

            if (weatherData.error) {
                console.error('Weather API error:', weatherData.error);
                return;
            }

            this._weatherData = weatherData;
            this.updateForecastDisplay(weatherData);
        } catch (error) {
            console.error('Error loading forecast:', error);
        }
    }

    updateForecastDisplay(weatherData) {
        if (!weatherData.current || !weatherData.daily) return;

        const cur = weatherData.current;

        // Hero: current temp, condition, feels like
        document.getElementById('wxHeroTemp').textContent = `${Math.round(cur.temperature_2m)}°`;
        document.getElementById('wxHeroCond').textContent = this.getWeatherDescription(cur.weather_code);
        if (cur.apparent_temperature != null) {
            document.getElementById('wxHeroFeels').textContent = `Feels like ${Math.round(cur.apparent_temperature)}°`;
        }

        // Stat cards
        const windDir = this.getWindDirection(cur.wind_direction_10m);
        document.getElementById('wxStatWind').innerHTML = `${Math.round(cur.wind_speed_10m)} <sub>mph ${windDir}</sub>`;
        document.getElementById('wxStatHumidity').innerHTML = `${Math.round(cur.relative_humidity_2m)}<sub>%</sub>`;
        document.getElementById('wxStatUV').textContent = Math.round(cur.uv_index) ?? '--';

        // Precip from current hour in hourly data
        const now = new Date();
        const nowHourStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}`;
        const hourlyTimes = weatherData.hourly?.time || [];
        let curHourIdx = hourlyTimes.findIndex(t => t.startsWith(nowHourStr));
        if (curHourIdx < 0) curHourIdx = 0;
        const precip = weatherData.hourly?.precipitation_probability?.[curHourIdx] ?? '--';
        document.getElementById('wxStatPrecip').innerHTML = `${precip}<sub>%</sub>`;

        // Hourly strip — 8 slots starting from current hour
        const hourlyHtml = [];
        for (let i = 0; i < 8; i++) {
            const idx = curHourIdx + i;
            if (idx >= hourlyTimes.length) break;
            const timeLabel = i === 0
                ? 'Now'
                : new Date(hourlyTimes[idx]).toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
            const temp = Math.round(weatherData.hourly.temperature_2m[idx]);
            const iconClass = this.getWeatherIcon(weatherData.hourly.weather_code[idx]) || 'fa-cloud';
            hourlyHtml.push(`
                <div class="wx-h-item${i === 0 ? ' now' : ''}">
                    <div class="wx-h-time">${timeLabel}</div>
                    <div class="wx-h-icon"><i class="fas ${iconClass}"></i></div>
                    <div class="wx-h-temp">${temp}°</div>
                </div>`);
        }
        this.domCache.wxHourlyStrip.innerHTML = hourlyHtml.join('');

        // Daily strip — 7 days (tappable → day detail)
        const dailyHtml = weatherData.daily.time.slice(0, 7).map((_, i) => {
            const date = new Date();
            date.setDate(date.getDate() + i);
            const dow = date.toLocaleDateString('en-US', { weekday: 'short' });
            const maxTemp = Math.round(weatherData.daily.temperature_2m_max[i]);
            const minTemp = Math.round(weatherData.daily.temperature_2m_min[i]);
            const iconClass = this.getWeatherIcon(weatherData.daily.weather_code[i]) || 'fa-cloud';
            return `
                <div class="wx-d-item" ontouchend="smartDisplay.showWxDayDetail(${i})" onclick="smartDisplay.showWxDayDetail(${i})">
                    <div class="wx-d-dow">${dow}</div>
                    <div class="wx-d-icon"><i class="fas ${iconClass}"></i></div>
                    <div class="wx-d-high">${maxTemp}°</div>
                    <div class="wx-d-low">${minTemp}°</div>
                </div>`;
        }).join('');
        this.domCache.wxDailyStrip.innerHTML = dailyHtml;
    }

    async loadAgenda(retryCount = 0) {
        const MAX_RETRIES = 5;
        const RETRY_DELAY_MS = 2000;
        try {
            const response = await fetch('/api/calendar/agenda');
            if (response.status === 503) {
                if (retryCount < MAX_RETRIES) {
                    console.log(`Agenda: server initializing, retry ${retryCount + 1}/${MAX_RETRIES} in ${RETRY_DELAY_MS/1000}s`);
                    setTimeout(() => this.loadAgenda(retryCount + 1), RETRY_DELAY_MS);
                } else {
                    this.updateAgendaDisplay([]);
                }
                return;
            }
            const events = await response.json();
            this.updateAgendaDisplay(events);
        } catch (error) {
            console.error('Error loading agenda:', error);
            if (retryCount < MAX_RETRIES) {
                setTimeout(() => this.loadAgenda(retryCount + 1), RETRY_DELAY_MS);
            } else {
                this.updateAgendaDisplay([]);
            }
        }
    }

    updateAgendaDisplay(events) {
        const agendaContent = this.domCache.agendaContent;

        if (events.length === 0) {
            agendaContent.innerHTML = '<div class="loading">No upcoming events</div>';
            return;
        }

        // Group events by day
        const eventsByDay = {};
        events.forEach(event => {
            let dayKey;
            
            if (event.start.dateTime) {
                // For timed events, use the date from the datetime
                const startTime = new Date(event.start.dateTime);
                dayKey = startTime.toDateString();
            } else {
                // For all-day events, use the date directly and ensure it's parsed as local time
                const [year, month, day] = event.start.date.split('-').map(Number);
                const startDate = new Date(year, month - 1, day); // month is 0-indexed
                dayKey = startDate.toDateString();
            }
            
            if (!eventsByDay[dayKey]) {
                eventsByDay[dayKey] = [];
            }
            eventsByDay[dayKey].push(event);
        });

        // Sort days chronologically
        const sortedDays = Object.keys(eventsByDay).sort((a, b) => {
            return new Date(a) - new Date(b);
        });
        let agendaHtml = '';

        sortedDays.forEach(dayKey => {
            const dayDate = new Date(dayKey);
            const dayHeader = dayDate.toLocaleDateString('en-US', { 
                weekday: 'long', 
                month: 'short', 
                day: 'numeric' 
            });
            
            agendaHtml += `<div class="agenda-day-header">${dayHeader}</div>`;
            
            // Sort events within each day: all-day events first, then by start time
            const sortedEvents = eventsByDay[dayKey].sort((a, b) => {
                const aIsAllDay = !a.start.dateTime;
                const bIsAllDay = !b.start.dateTime;
                
                // All-day events first
                if (aIsAllDay && !bIsAllDay) return -1;
                if (!aIsAllDay && bIsAllDay) return 1;
                
                // Then by start time
                const aStart = new Date(a.start.dateTime || a.start.date);
                const bStart = new Date(b.start.dateTime || b.start.date);
                return aStart - bStart;
            });
            
            sortedEvents.forEach(event => {
                const startTime = new Date(event.start.dateTime || event.start.date);
                const endTime = new Date(event.end.dateTime || event.end.date);
                const isAllDay = !event.start.dateTime; // All-day events have date but no dateTime
                
                let timeString;
                let durationText;
                let eventClass = 'agenda-event';
                
                if (isAllDay) {
                    timeString = 'All day';
                    durationText = '';
                    eventClass += ' all-day-event';
                } else {
                    timeString = startTime.toLocaleTimeString('en-US', {
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: true
                    });
                    
                    const duration = Math.round((endTime - startTime) / (1000 * 60));
                    durationText = duration < 60 ? `${duration}m` : `${Math.round(duration / 60)}h ${duration % 60}m`;
                }

                let locationHtml = '';
                if (event.location) {
                    locationHtml = `<div class="agenda-event-location">📍 ${event.location}</div>`;
                }

                agendaHtml += `
                    <div class="${eventClass}">
                        <div class="agenda-event-time">${timeString}</div>
                        <div class="agenda-event-title">${event.summary}</div>
                        ${durationText ? `<div class="agenda-event-duration">${durationText}</div>` : ''}
                        ${locationHtml}
                    </div>
                `;
            });
        });

        agendaContent.innerHTML = agendaHtml;
    }

    loadSettings() {
        const saved = localStorage.getItem('smartDisplaySettings');
        return saved ? JSON.parse(saved) : {
            photoQuery: 'nature landscape',
            haUrl: 'http://your-home-assistant-url:8123',
            latitude: 40.7128,
            longitude: -74.0060,
            summaryEnabled: true,
            summaryTime: '08:00',
            userName: ''
        };
    }

    checkHourlySummary() {
        // Auto-navigation to the summary card has been removed.
        // The summary is only shown when the user explicitly taps the button.
    }

    showDailySummary() {
        // No-op — kept for safety in case any other caller references it.
    }

    async loadSummary(forceRefresh = false) {
        try {
            const userName = this.settings.userName || '';
            const url = forceRefresh 
                ? `/api/summary?name=${encodeURIComponent(userName)}&refresh=true`
                : `/api/summary?name=${encodeURIComponent(userName)}`;
            
            const response = await fetch(url);
            const data = await response.json();
            
            this.updateSummaryDisplay(data);
        } catch (error) {
            console.error('Error loading summary:', error);
            this.updateSummaryDisplay({
                summary: "Sorry, I couldn't generate your daily summary right now.",
                timestamp: new Date().toISOString()
            });
        }
    }

    async refreshSummary() {
        try {
            // Show loading state
            const refreshBtn = document.getElementById('summaryRefreshBtn');
            const originalContent = refreshBtn.innerHTML;
            refreshBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
            refreshBtn.disabled = true;
            
            const userName = this.settings.userName || '';
            const response = await fetch(`/api/summary?name=${encodeURIComponent(userName)}&refresh=true`);
            const data = await response.json();
            
            this.updateSummaryDisplay(data);
            
            // Restore button state
            refreshBtn.innerHTML = originalContent;
            refreshBtn.disabled = false;
        } catch (error) {
            console.error('Error refreshing summary:', error);
            
            // Restore button state on error
            const refreshBtn = document.getElementById('summaryRefreshBtn');
            refreshBtn.innerHTML = '<i class="fas fa-sync-alt"></i>';
            refreshBtn.disabled = false;
        }
    }

    updateSummaryDisplay(data) {
        const summaryContent = this.domCache.summaryContent;
        
        // Format the summary with highlights
        let formattedSummary = data.summary || data.error || 'Summary unavailable — try again later.';

        // Add highlighting for events and weather
        formattedSummary = formattedSummary
            .replace(/\*\*(.*?)\*\*/g, '<span class="highlight">$1</span>')
            .replace(/(\d{1,2}:\d{2}\s*(?:AM|PM).*?)/g, '<span class="event-highlight">$1</span>')
            .replace(/(All day.*?)/g, '<span class="event-highlight">$1</span>')
            .replace(/(\d+\.?\d*°F)/gi, '<span class="weather-highlight">$1</span>')
            .replace(/(humidity is at \d+%)/gi, '<span class="weather-highlight">$1</span>')
            .replace(/(temperature of \d+\.?\d*°F)/gi, '<span class="weather-highlight">$1</span>')
            .replace(/(\d+°F|sunny|cloudy|rainy|snow)/gi, '<span class="weather-highlight">$1</span>')
            .replace(/\n/g, '<br>');

        summaryContent.innerHTML = `<p>${formattedSummary}</p>`;
    }

    refreshPage() {
        // Close settings modal first
        this.closeSettings();
        
        // Show a brief loading message
        const loadingMsg = document.createElement('div');
        loadingMsg.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0,0,0,0.8);
            color: white;
            padding: 20px;
            border-radius: 10px;
            z-index: 10000;
            font-size: 16px;
        `;
        loadingMsg.innerHTML = '<i class="fas fa-sync-alt fa-spin"></i> Refreshing page...';
        document.body.appendChild(loadingMsg);
        
        // Refresh the page after a short delay
        setTimeout(() => {
            window.location.reload();
        }, 500);
    }

    openHourlyForecast(dayIndex) {
        const overlay = document.getElementById('hourlyForecastOverlay');
        const title = document.getElementById('hourlyForecastTitle');
        const grid = document.getElementById('hourlyForecastGrid');
        
        // Set title based on day
        const dayNames = ['Today', 'Tomorrow', 'Wednesday', 'Thursday', 'Friday'];
        title.textContent = `${dayNames[dayIndex]} - Hourly Forecast`;
        
        // Load hourly data for the selected day
        this.loadHourlyForecastData(dayIndex, grid);
        
        // Show overlay
        overlay.classList.add('active');
        
        // Disable carousel navigation
        this.disableCarouselNavigation();
    }

    closeHourlyForecast() {
        const overlay = document.getElementById('hourlyForecastOverlay');
        overlay.classList.remove('active');
        
        // Re-enable carousel navigation
        this.enableCarouselNavigation();
    }

    async loadHourlyForecastData(dayIndex, grid) {
        try {
            const response = await fetch(`/api/weather?lat=${this.settings.latitude}&lon=${this.settings.longitude}`);
            const weatherData = await response.json();
            
            if (!weatherData.hourly) {
                grid.innerHTML = '<div class="loading">No hourly data available</div>';
                return;
            }

            // Get the target date
            const targetDate = new Date();
            targetDate.setDate(targetDate.getDate() + dayIndex);
            const targetDateString = targetDate.toISOString().split('T')[0];

            // Filter hourly data for the target day
            const hourlyData = [];
            for (let i = 0; i < weatherData.hourly.time.length; i++) {
                const hourTime = new Date(weatherData.hourly.time[i]);
                const hourDateString = hourTime.toISOString().split('T')[0];
                
                if (hourDateString === targetDateString) {
                    hourlyData.push({
                        time: hourTime,
                        temperature: weatherData.hourly.temperature_2m[i],
                        weatherCode: weatherData.hourly.weather_code[i],
                        precipitation: weatherData.hourly.precipitation_probability[i],
                        uvIndex: weatherData.hourly.uv_index[i],
                        windSpeed: weatherData.hourly.wind_speed_10m[i],
                        windDirection: weatherData.hourly.wind_direction_10m[i]
                    });
                }
            }

            // Generate HTML for hourly forecast
            const hourlyHTML = hourlyData.map(hour => {
                const timeString = hour.time.toLocaleTimeString('en-US', { 
                    hour: '2-digit', 
                    minute: '2-digit', 
                    hour12: true 
                });
                
                const weatherIcon = this.getWeatherIcon(hour.weatherCode);
                const uvClass = this.getUVClass(hour.uvIndex);
                
                return `
                    <div class="hourly-forecast-item">
                        <div class="hourly-time">${timeString}</div>
                        <div class="hourly-temp">${Math.round(hour.temperature)}°F</div>
                        <div class="hourly-icon">
                            <i class="fas ${weatherIcon}"></i>
                        </div>
                        <div class="hourly-precip">${hour.precipitation}% rain</div>
                        <div class="hourly-uv ${uvClass}">UV: ${hour.uvIndex}</div>
                        <div class="hourly-wind">${Math.round(hour.windSpeed)} mph</div>
                    </div>
                `;
            }).join('');

            grid.innerHTML = hourlyHTML;

        } catch (error) {
            console.error('Error loading hourly forecast:', error);
            grid.innerHTML = '<div class="loading">Error loading hourly forecast</div>';
        }
    }

    getUVClass(uvIndex) {
        if (uvIndex <= 2) return 'uv-low';
        if (uvIndex <= 5) return 'uv-moderate';
        if (uvIndex <= 7) return 'uv-high';
        if (uvIndex <= 10) return 'uv-very-high';
        return 'uv-extreme';
    }

    disableCarouselNavigation() {
        // Disable touch areas
        this.domCache.leftTouchArea.style.pointerEvents = 'none';
        this.domCache.rightTouchArea.style.pointerEvents = 'none';
        
        // Disable keyboard navigation
        this.carouselNavigationDisabled = true;
        
        // Disable mouse/touch swipe events
        this.swipeEventsDisabled = true;
        
        // Disable body scrolling on Raspberry Pi
        document.body.style.overflow = 'hidden';
        document.body.style.position = 'fixed';
        document.body.style.width = '100%';
    }

    enableCarouselNavigation() {
        // Re-enable touch areas
        this.domCache.leftTouchArea.style.pointerEvents = 'auto';
        this.domCache.rightTouchArea.style.pointerEvents = 'auto';

        // Re-enable keyboard navigation
        this.carouselNavigationDisabled = false;

        // Re-enable mouse/touch swipe events
        this.swipeEventsDisabled = false;

        // Re-enable body scrolling on Raspberry Pi
        document.body.style.overflow = '';
        document.body.style.position = '';
        document.body.style.width = '';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CALENDAR — Day / Week / Month three-view system for Card 4
    // ─────────────────────────────────────────────────────────────────────────

    /** Returns the Sunday that starts the week containing `date`. */
    _weekStartFor(date) {
        const d = new Date(date);
        d.setDate(d.getDate() - d.getDay()); // back up to Sunday
        d.setHours(0, 0, 0, 0);
        return d;
    }

    /**
     * Called once from init(). Injects the Day|Week|Month segmented toggle,
     * plus the three view containers, into the agenda card. All new HTML and
     * CSS live here — no changes to index.html or styles.css required.
     */
    setupCalendarGrid() {
        this.injectCalendarGridStyles();

        // Initialise week start state now that the helper exists
        this.calendarWeekStart = this._weekStartFor(new Date());

        const agendaContent = this.domCache.agendaContent;
        if (!agendaContent) {
            console.warn('setupCalendarGrid: agendaContent not found — calendar disabled');
            return;
        }

        const agendaContainer = agendaContent.parentElement;
        const agendaHeader    = agendaContainer ? agendaContainer.querySelector('.agenda-header') : null;

        // ── Photo background (inserted first so it sits behind everything) ────
        if (agendaContainer && !document.getElementById('calPhotoBg')) {
            const calPhotoBg = document.createElement('div');
            calPhotoBg.id = 'calPhotoBg';
            calPhotoBg.className = 'cal-photo-bg';
            calPhotoBg.innerHTML = `
                <img class="cal-photo-img" id="calPhotoSlot0" src="" alt="">
                <img class="cal-photo-img cal-photo-hidden" id="calPhotoSlot1" src="" alt="">
                <div class="cal-photo-overlay"></div>`;
            agendaContainer.insertAdjacentElement('afterbegin', calPhotoBg);
            this.setupCalendarBackground();
        }

        // ── Patch header: title → "Calendar", replace Month btn with toggle ───
        if (agendaHeader) {
            // Hide title span — replaced by the view toggle
            const titleEl = agendaHeader.querySelector('.agenda-title, h2, span:not(.ha-back-btn)');
            if (titleEl) titleEl.style.display = 'none';
            // Replace agenda back btn with a home icon
            const agendaBackBtn = document.getElementById('agendaBackBtn');
            if (agendaBackBtn) {
                agendaBackBtn.innerHTML = '<i class="fas fa-home"></i>';
                agendaBackBtn.style.display = '';
            }

            // Build Day|Week|Month segmented toggle
            const toggle = document.createElement('div');
            toggle.id        = 'calViewToggle';
            toggle.className = 'cal-view-toggle';
            toggle.innerHTML = `
                <button class="cal-toggle-btn" data-view="day">Day</button>
                <button class="cal-toggle-btn" data-view="week">Week</button>
                <button class="cal-toggle-btn" data-view="month">Month</button>`;

            toggle.style.marginLeft = 'auto';
            agendaHeader.appendChild(toggle);

            // Delegate clicks on the toggle
            toggle.addEventListener('click', (e) => {
                const btn = e.target.closest('.cal-toggle-btn');
                if (!btn) return;
                this.resetCalendarAutoReturn();
                this.showCalendarView(btn.dataset.view);
            });
        }

        // ── Month view container ──────────────────────────────────────────────
        const monthView = document.createElement('div');
        monthView.id        = 'calendarMonthView';
        monthView.className = 'cal-month-view';
        monthView.style.display = 'none';
        monthView.innerHTML = `
            <div class="cal-month-header">
                <button class="cal-nav-btn" id="calPrevMonth" aria-label="Previous month">&#8249;</button>
                <span class="cal-period-title" id="calMonthTitle"></span>
                <button class="cal-nav-btn" id="calNextMonth" aria-label="Next month">&#8250;</button>
            </div>
            <div class="cal-month-body">
                <div class="cal-month-main">
                    <div class="cal-dow-row">
                        <div>Sun</div><div>Mon</div><div>Tue</div>
                        <div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div>
                    </div>
                    <div class="cal-grid" id="calGrid"></div>
                </div>
                <div class="cal-month-sidebar">
                    <div class="cal-sidebar-heading">
                        <span class="cal-sidebar-title">Upcoming</span>
                        <span class="cal-sidebar-count" id="calSidebarCount"></span>
                    </div>
                    <div class="cal-sidebar-events" id="calMonthSidebar"></div>
                </div>
            </div>
            <div class="cal-return-bar">
                <div class="cal-return-progress" id="calReturnProgress"></div>
            </div>`;
        agendaContent.insertAdjacentElement('beforebegin', monthView);

        // ── Week view container ───────────────────────────────────────────────
        const weekView = document.createElement('div');
        weekView.id        = 'calendarWeekView';
        weekView.className = 'cal-week-view';
        weekView.style.display = 'none';
        weekView.innerHTML = `
            <div class="cal-week-header">
                <button class="cal-nav-btn" id="calPrevWeek" aria-label="Previous week">&#8249;</button>
                <span class="cal-period-title" id="calWeekTitle"></span>
                <button class="cal-nav-btn" id="calNextWeek" aria-label="Next week">&#8250;</button>
            </div>
            <div class="cal-grid-week" id="calWeekGrid"></div>
            <div class="cal-return-bar">
                <div class="cal-return-progress" id="calWeekReturnProgress"></div>
            </div>`;
        agendaContent.insertAdjacentElement('beforebegin', weekView);

        // ── Day view container ────────────────────────────────────────────────
        const dayView = document.createElement('div');
        dayView.id        = 'calendarDayView';
        dayView.className = 'cal-day-view';
        dayView.style.display = 'none';
        dayView.innerHTML = `
            <div class="cal-day-header">
                <button class="cal-nav-btn cal-nav-arrow" id="calPrevDay" aria-label="Previous day">&#8592;</button>
                <span class="cal-period-title" id="calDayTitle"></span>
                <button class="cal-nav-btn cal-nav-arrow" id="calNextDay" aria-label="Next day">&#8594;</button>
            </div>
            <div class="cal-day-events" id="calDayEvents"></div>
            <div class="cal-return-bar">
                <div class="cal-return-progress" id="calDayReturnProgress"></div>
            </div>`;
        agendaContent.insertAdjacentElement('beforebegin', dayView);

        // ── Ambient card (Card 0) shortcut buttons ────────────────────────────
        const photoSlideshow = this.domCache.photoSlideshow;
        if (photoSlideshow) {
            const shortcuts = document.createElement('div');
            shortcuts.className = 'ambient-shortcuts';

            // Wire the static Weather button (lives next to the weather pill in index.html)
            const weatherShortcutBtn = document.getElementById('weatherShortcutBtn');
            if (weatherShortcutBtn) {
                weatherShortcutBtn.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
                weatherShortcutBtn.addEventListener('touchend',   e => e.stopPropagation(), { passive: true });
            }

            const btns = [
                { label: 'Calendar',     icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`, card: 4 },
                { label: 'Summary',      icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`, card: 1 },
                { label: 'This Picture', icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`, action: () => this.showPhotoInfo() },
            ];

            btns.forEach(({ label, icon, card, action }) => {
                const btn = document.createElement('button');
                const idMap = { 'Calendar': 'calAmbientShortcutBtn', 'Summary': 'summaryAmbientShortcutBtn', 'This Picture': 'thisPictureShortcutBtn' };
                btn.id        = idMap[label] || '';
                btn.className = 'cal-ambient-shortcut-btn';
                btn.innerHTML = `${icon}${label}`;
                btn.addEventListener('click', action || (() => this.goToCard(card)));
                btn.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
                btn.addEventListener('touchend',   e => e.stopPropagation(), { passive: true });
                shortcuts.appendChild(btn);
            });

            document.getElementById('photoInfoDismiss')?.addEventListener('click', e => {
                e.stopPropagation();
                this.hidePhotoInfo();
            });
            document.getElementById('photoInfoOverlay')?.addEventListener('click', () => this.hidePhotoInfo());

            photoSlideshow.appendChild(shortcuts);
        }

        // ── Month nav listeners ───────────────────────────────────────────────
        document.getElementById('calPrevMonth').addEventListener('click', () => {
            this.resetCalendarAutoReturn();
            this.navigateMonth(-1);
        });
        document.getElementById('calNextMonth').addEventListener('click', () => {
            this.resetCalendarAutoReturn();
            this.navigateMonth(1);
        });

        // ── Week nav listeners ────────────────────────────────────────────────
        document.getElementById('calPrevWeek').addEventListener('click', () => {
            this.resetCalendarAutoReturn();
            this.navigateWeek(-1);
        });
        document.getElementById('calNextWeek').addEventListener('click', () => {
            this.resetCalendarAutoReturn();
            this.navigateWeek(1);
        });

        // ── Day nav listeners ─────────────────────────────────────────────────
        document.getElementById('calPrevDay').addEventListener('click', () => {
            this.resetCalendarAutoReturn();
            this.navigateDay(-1);
        });
        document.getElementById('calNextDay').addEventListener('click', () => {
            this.resetCalendarAutoReturn();
            this.navigateDay(1);
        });

        // Week column tap → enter day view for that day
        document.getElementById('calWeekGrid').addEventListener('click', (e) => {
            const col = e.target.closest('.cal-week-col');
            if (!col) return;
            const ds = col.getAttribute('data-date');
            if (!ds) return;
            const p  = ds.split('-');
            const dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
            this.calendarDayDate = dt;
            this.resetCalendarAutoReturn();
            this.showCalendarView('day');
        });

        // Month tap → enter day view for selected date
        document.getElementById('calGrid').addEventListener('click', (e) => {
            const cell = e.target.closest('.cal-day-cell:not(.other-month)');
            if (!cell) return;
            const ds = cell.getAttribute('data-date');
            if (!ds) return;
            const p  = ds.split('-');
            const dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
            this.calendarDayDate = dt;
            this.showCalendarView('day');
        });

        // Touch-scroll in day/week event lists must not trigger carousel swipe
        ['calDayEvents', 'calWeekGrid'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: false });
        });

        // Any touch inside calendar views resets auto-return
        [monthView, weekView, dayView].forEach(v => {
            v.addEventListener('touchstart', () => this.resetCalendarAutoReturn(), { passive: true });
        });

        // Cache containers
        this.domCache.calendarMonthView = monthView;
        this.domCache.calendarWeekView  = weekView;
        this.domCache.calendarDayView   = dayView;
    }

    /**
     * Fetch local Boundary Waters photo list from /api/local-photos, shuffle,
     * and start a 30-second crossfade rotation behind the calendar card.
     * Fails silently — if the endpoint is absent the card just has no background photo.
     */
    setupCalendarBackground() {
        this._calPhotoFiles  = [];
        this._calPhotoIndex  = 0;
        this._calActiveSlot  = 0;
        this._calPhotoTimer  = null;

        fetch('/api/local-photos')
            .then(r => r.json())
            .then(data => {
                const files = (data.files || []).slice();
                console.log('[calBg] local-photos returned', files.length, 'files');
                if (!files.length) return;

                // Fisher-Yates shuffle for random order each session
                for (let i = files.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [files[i], files[j]] = [files[j], files[i]];
                }
                this._calPhotoFiles = files;

                const slot0 = document.getElementById('calPhotoSlot0');
                const slot1 = document.getElementById('calPhotoSlot1');
                if (slot0) slot0.src = '/photos/' + encodeURIComponent(files[0]);
                if (slot1 && files.length > 1) slot1.src = '/photos/' + encodeURIComponent(files[1]);
                this._calPhotoIndex = 1;

                this._calPhotoTimer = setInterval(() => this._calNextPhoto(), 30000);
            })
            .catch(err => console.warn('[calBg] fetch failed:', err.message));
    }

    _calNextPhoto() {
        if (!this._calPhotoFiles.length) return;
        const slot0 = document.getElementById('calPhotoSlot0');
        const slot1 = document.getElementById('calPhotoSlot1');
        if (!slot0 || !slot1) return;

        const next = this._calActiveSlot === 0 ? slot1 : slot0;
        const prev = this._calActiveSlot === 0 ? slot0 : slot1;

        next.classList.remove('cal-photo-hidden');
        requestAnimationFrame(() => requestAnimationFrame(() => {
            prev.classList.add('cal-photo-hidden');
        }));

        this._calActiveSlot  = this._calActiveSlot === 0 ? 1 : 0;
        this._calPhotoIndex  = (this._calPhotoIndex + 1) % this._calPhotoFiles.length;

        // Preload next-next into the now-fading slot after transition settles
        const preloadIdx = (this._calPhotoIndex + 1) % this._calPhotoFiles.length;
        setTimeout(() => {
            prev.src = '/photos/' + encodeURIComponent(this._calPhotoFiles[preloadIdx]);
        }, 2000);
    }

    setupWeatherBackground() {
        this._wxPhotoFiles  = [];
        this._wxPhotoIndex  = 0;
        this._wxActiveSlot  = 0;
        this._wxPhotoTimer  = null;

        fetch('/api/local-photos')
            .then(r => r.json())
            .then(data => {
                const files = (data.files || []).slice();
                console.log('[wxBg] local-photos returned', files.length, 'files');
                if (!files.length) return;

                for (let i = files.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [files[i], files[j]] = [files[j], files[i]];
                }
                this._wxPhotoFiles = files;

                const slot0 = document.getElementById('wxPhotoSlot0');
                const slot1 = document.getElementById('wxPhotoSlot1');
                if (slot0) slot0.src = '/photos/' + encodeURIComponent(files[0]);
                if (slot1 && files.length > 1) slot1.src = '/photos/' + encodeURIComponent(files[1]);
                this._wxPhotoIndex = 1;

                this._wxPhotoTimer = setInterval(() => this._wxNextPhoto(), 30000);
            })
            .catch(err => console.warn('[wxBg] fetch failed:', err.message));
    }

    _wxNextPhoto() {
        if (!this._wxPhotoFiles.length) return;
        const slot0 = document.getElementById('wxPhotoSlot0');
        const slot1 = document.getElementById('wxPhotoSlot1');
        if (!slot0 || !slot1) return;

        const next = this._wxActiveSlot === 0 ? slot1 : slot0;
        const prev = this._wxActiveSlot === 0 ? slot0 : slot1;

        next.classList.remove('wx-photo-hidden');
        requestAnimationFrame(() => requestAnimationFrame(() => {
            prev.classList.add('wx-photo-hidden');
        }));

        this._wxActiveSlot = this._wxActiveSlot === 0 ? 1 : 0;
        this._wxPhotoIndex = (this._wxPhotoIndex + 1) % this._wxPhotoFiles.length;

        const preloadIdx = (this._wxPhotoIndex + 1) % this._wxPhotoFiles.length;
        setTimeout(() => {
            prev.src = '/photos/' + encodeURIComponent(this._wxPhotoFiles[preloadIdx]);
        }, 2000);
    }

    showWxDayDetail(dayIndex) {
        const data = this._weatherData;
        if (!data?.hourly) return;

        const date = new Date();
        date.setDate(date.getDate() + dayIndex);
        const dateLabel = date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        const targetStr = date.toISOString().split('T')[0];
        const high = Math.round(data.daily.temperature_2m_max[dayIndex]);
        const low  = Math.round(data.daily.temperature_2m_min[dayIndex]);

        document.getElementById('wxDdTitle').textContent = dateLabel;
        document.getElementById('wxDdRange').textContent = `High ${high}° · Low ${low}°`;

        const strip = document.getElementById('wxDhStrip');
        const items = [];
        for (let i = 0; i < data.hourly.time.length; i++) {
            if (!data.hourly.time[i].startsWith(targetStr)) continue;
            const t = new Date(data.hourly.time[i]);
            const label = t.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true }).replace(' ', '').toLowerCase();
            const temp  = Math.round(data.hourly.temperature_2m[i]);
            const rain  = data.hourly.precipitation_probability[i] ?? 0;
            const icon  = this.getWeatherIcon(data.hourly.weather_code[i]) || 'fa-cloud';
            items.push(`
                <div class="wx-dh-item">
                    <div class="wx-dh-time">${label}</div>
                    <div class="wx-dh-icon"><i class="fas ${icon}"></i></div>
                    <div class="wx-dh-temp">${temp}°</div>
                    <div class="wx-dh-rain">${rain > 0 ? rain + '%' : ''}</div>
                </div>`);
        }
        strip.innerHTML = items.join('');

        document.getElementById('wxNormal').style.display = 'none';
        document.getElementById('wxDayDetail').classList.add('visible');

        // Scroll to current hour for today, or 8am for future days
        const scrollToIdx = dayIndex === 0 ? new Date().getHours() : 8;
        setTimeout(() => {
            const target = strip.children[scrollToIdx];
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
        }, 50);

        // Reset the weather auto-return timer
        this.startWeatherAutoReturn();
    }

    closeWxDayDetail() {
        const normal = document.getElementById('wxNormal');
        const detail = document.getElementById('wxDayDetail');
        if (normal) normal.style.display = '';
        if (detail) detail.classList.remove('visible');
        this.startWeatherAutoReturn();
    }

    // ── Radar overlay ────────────────────────────────────────────────────────
    openRadar() {
        const overlay = document.getElementById('wxRadarOverlay');
        if (!overlay) return;
        overlay.classList.add('visible');
        this.startWeatherAutoReturn();

        clearInterval(this._radarRefreshTimer);
        this._radarRefreshTimer = setInterval(() => this._fetchRadarFrames(), 10 * 60 * 1000);

        if (!this._radarReady) {
            this._radarReady = true;
            setTimeout(() => this._initRadarMap(), 60);
        } else {
            if (this._radarMap) this._radarMap.invalidateSize();
            const stale = Date.now() - this._radarLastFetch > 10 * 60 * 1000;
            if (stale) {
                this._fetchRadarFrames();
            } else {
                this._startRadarAnim();
            }
        }
    }

    closeRadar() {
        const overlay = document.getElementById('wxRadarOverlay');
        if (overlay) overlay.classList.remove('visible');
        this._stopRadarAnim();
        clearInterval(this._radarRefreshTimer);
        this._radarRefreshTimer = null;
    }

    _initRadarMap() {
        this._radarMap = L.map('wxRadarMap', {
            center: [YOUR_LATITUDE, YOUR_LONGITUDE],
            zoom: 7,
            zoomControl: false,
            attributionControl: false,
            scrollWheelZoom: false,
        });
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            subdomains: 'abcd', maxZoom: 19,
        }).addTo(this._radarMap);

        L.marker([YOUR_LATITUDE, YOUR_LONGITUDE], {
            icon: L.divIcon({
                className: '',
                html: '<span style="font-size:13px;line-height:1;color:#ffd700;text-shadow:0 0 5px rgba(0,0,0,0.9),0 0 2px rgba(0,0,0,1)">★</span>',
                iconSize: [13, 13],
                iconAnchor: [6, 7],
            }),
            interactive: false,
        }).addTo(this._radarMap);

        L.marker([45.5286, -91.9996], {
            icon: L.divIcon({
                className: '',
                html: '<span style="font-size:13px;line-height:1;color:#a1d494;text-shadow:0 0 5px rgba(0,0,0,0.9),0 0 2px rgba(0,0,0,1)">★</span>',
                iconSize: [13, 13],
                iconAnchor: [6, 7],
            }),
            interactive: false,
        }).addTo(this._radarMap);

        this._fetchRadarFrames();
    }

    async _fetchRadarFrames() {
        const tsEl = document.getElementById('wxRadarTs');
        if (tsEl) tsEl.textContent = 'Loading…';
        try {
            // Remove stale layers before rebuilding
            this._stopRadarAnim();
            this._radarLayers.forEach(l => { try { this._radarMap.removeLayer(l); } catch(e) {} });
            this._radarLayers = [];
            this._radarFrames = [];

            const resp = await fetch('https://api.rainviewer.com/public/weather-maps.json');
            const data = await resp.json();
            this._radarHost   = data.host;
            this._radarFrames = (data.radar.past || []).slice(-12);
            this._radarLastFetch = Date.now();

            this._radarLayers = this._radarFrames.map(f => {
                const layer = L.tileLayer(
                    `${this._radarHost}${f.path}/256/{z}/{x}/{y}/4/1_1.png`,
                    { opacity: 0, maxZoom: 14, zIndex: 200 }
                );
                layer.addTo(this._radarMap);
                return layer;
            });

            const bar = document.getElementById('wxRadarFrameBar');
            if (bar) {
                bar.innerHTML = this._radarFrames.map((f, i) => {
                    const lbl = new Date(f.time * 1000)
                        .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
                    return `<div class="wx-radar-tick" id="wxRTick${i}">
                        <span class="wx-radar-tick-lbl">${lbl}</span>
                        <div class="wx-radar-tick-bar"></div>
                    </div>`;
                }).join('');
            }

            this._radarIdx = 0;
            this._showRadarFrame(0);
            this._startRadarAnim();
        } catch (e) {
            const tsEl2 = document.getElementById('wxRadarTs');
            if (tsEl2) tsEl2.textContent = 'Unavailable';
            console.warn('[radar] fetch failed:', e.message);
        }
    }

    _showRadarFrame(i) {
        this._radarLayers.forEach((l, j) => l.setOpacity(j === i ? 0.65 : 0));
        document.querySelectorAll('#wxRadarFrameBar .wx-radar-tick').forEach((t, j) => {
            t.className = 'wx-radar-tick' + (j === i ? ' active' : j < i ? ' past' : '');
        });
        const tsEl = document.getElementById('wxRadarTs');
        if (tsEl && this._radarFrames[i]) {
            tsEl.textContent = new Date(this._radarFrames[i].time * 1000)
                .toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
        }
    }

    _startRadarAnim() {
        this._stopRadarAnim();
        if (!this._radarPlaying || !this._radarFrames.length) return;
        this._radarTimer = setInterval(() => {
            this._radarIdx = (this._radarIdx + 1) % this._radarFrames.length;
            this._showRadarFrame(this._radarIdx);
        }, 650);
    }

    _stopRadarAnim() {
        clearInterval(this._radarTimer);
        this._radarTimer = null;
    }

    toggleRadarPlay() {
        this._radarPlaying = !this._radarPlaying;
        const icon = document.getElementById('wxRadarPlayIcon');
        if (icon) icon.className = this._radarPlaying ? 'fas fa-pause' : 'fas fa-play';
        this._radarPlaying ? this._startRadarAnim() : this._stopRadarAnim();
    }

    /** Inject all calendar CSS as a <style> tag — keeps index.html/styles.css untouched */
    injectCalendarGridStyles() {
        if (document.getElementById('calendarGridStyles')) return; // already injected
        const style = document.createElement('style');
        style.id = 'calendarGridStyles';
        style.textContent = `
            /* ── Calendar header → dark glass ──────────────────────────────────── */
            .agenda-header {
                background: rgba(12,14,16,0.7) !important;
                backdrop-filter: blur(24px) !important;
                -webkit-backdrop-filter: blur(24px) !important;
                border-bottom: 1px solid rgba(67,71,76,0.35) !important;
                color: #e2e2e5 !important;
            }

            /* ── Toggle: text-only tabs with primary underline ──────────────────── */
            .cal-view-toggle { display: inline-flex; gap: 2px; flex-shrink: 0; }
            .cal-toggle-btn {
                background: none; border: none;
                border-bottom: 2px solid transparent;
                color: rgba(196,198,205,0.55);
                padding: 5px 14px 4px 14px;
                font-size: 11px; font-weight: 800;
                cursor: pointer; font-family: inherit;
                white-space: nowrap; text-transform: uppercase; letter-spacing: 0.12em;
                -webkit-tap-highlight-color: transparent;
                transition: color 0.15s, border-color 0.15s;
            }
            .cal-toggle-btn:hover { color: #e2e2e5; }
            .cal-toggle-btn.active { color: #b8c8db; border-bottom-color: #b8c8db; }

            /* ── Period title ───────────────────────────────────────────────────── */
            .cal-period-title {
                font-size: 15px; font-weight: 700; color: #e2e2e5;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                text-align: center; flex: 1; min-width: 0; letter-spacing: -0.02em;
            }

            /* ── Ghost nav buttons ──────────────────────────────────────────────── */
            .cal-nav-btn {
                background: rgba(51,53,55,0.25); border: 1px solid rgba(67,71,76,0.35);
                color: #c4c6cd; border-radius: 7px;
                width: 36px; height: 36px; font-size: 19px; line-height: 1;
                cursor: pointer; display: flex; align-items: center; justify-content: center;
                -webkit-tap-highlight-color: transparent;
                transition: background 0.15s, color 0.15s; flex-shrink: 0; font-family: inherit;
            }
            .cal-nav-btn:hover  { background: rgba(51,53,55,0.55); color: #e2e2e5; }
            .cal-nav-btn:active { background: rgba(51,53,55,0.8); }
            .cal-nav-arrow { width: 36px; height: 30px; font-size: 15px; border-radius: 6px; }
            .cal-nav-btn.disabled, .cal-nav-btn:disabled { opacity: 0.18; pointer-events: none; }

            /* ── Ambient shortcut buttons ───────────────────────────────────────── */
            .ambient-shortcuts {
                position: absolute; bottom: 24px; right: 18px; z-index: 10;
                display: flex; flex-direction: column; gap: 14px;
            }
            .cal-ambient-shortcut-btn {
                display: inline-flex; align-items: center; gap: 7px;
                background: rgba(18,20,22,0.72); border: 1px solid rgba(184,200,219,0.3);
                color: #b8c8db; border-radius: 10px; padding: 7px 18px;
                font-size: 20px; font-weight: 700; letter-spacing: 0.05em;
                cursor: pointer; font-family: inherit; backdrop-filter: blur(12px);
                transition: background 0.15s; -webkit-tap-highlight-color: transparent;
                position: relative; min-width: 120px; justify-content: center;
            }
            .cal-ambient-shortcut-btn:active { background: rgba(46,62,77,0.85); }
            #calAmbientShortcutBtn   { font-size: 25px; font-weight: 800; }
            #summaryAmbientShortcutBtn { font-size: 15px; font-weight: 600; }
            #thisPictureShortcutBtn  { font-size: 15px; font-weight: 600; flex-direction: column; white-space: normal; text-align: center; gap: 4px; min-width: 0; }
            #weatherShortcutBtn      { min-width: 0; }

            /* ── View containers ────────────────────────────────────────────────── */
            .cal-month-view, .cal-week-view, .cal-day-view {
                display: flex; flex-direction: column;
                flex: 1; overflow: hidden; background: transparent; padding: 0; margin: 0;
            }
            .cal-month-header, .cal-week-header, .cal-day-header {
                display: flex; align-items: center; justify-content: space-between;
                padding: 10px 24px; flex-shrink: 0;
            }

            /* ── Auto-return bar ────────────────────────────────────────────────── */
            .cal-return-bar { height: 2px; background: rgba(67,71,76,0.3); margin: 0; overflow: hidden; flex-shrink: 0; }
            .cal-return-progress { height: 100%; background: rgba(184,200,219,0.4); width: 100%; transition: none; }

            /* ════════════════════════════════════════════════════════════════════
               DAY VIEW — all-day chips → featured "Next Up" card → pill rows
               ════════════════════════════════════════════════════════════════════ */
            .cal-day-events {
                flex: 1; overflow-y: auto; padding: 10px 24px 12px 24px;
                -webkit-overflow-scrolling: touch; scrollbar-width: none;
            }
            .cal-day-events::-webkit-scrollbar { display: none; }

            /* All-day chips */
            .cal-allday-strip { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
            .cal-allday-chip {
                display: inline-flex; align-items: center;
                background: rgba(46,62,77,0.5); border: 1px solid rgba(184,200,219,0.2);
                color: #b8c8db; font-size: 11px; font-weight: 700;
                padding: 4px 12px 4px 10px; border-radius: 9999px; letter-spacing: 0.04em;
            }
            .cal-allday-chip::before {
                content: ''; display: inline-block; width: 5px; height: 5px; border-radius: 50%;
                background: #b8c8db; margin-right: 7px; flex-shrink: 0;
            }
            .cal-allday-chip.holiday { color: #ffb4ab; border-color: rgba(255,180,171,0.25); background: rgba(147,0,10,0.18); }
            .cal-allday-chip.holiday::before { background: #ffb4ab; }
            .cal-allday-chip.secondary { color: #a1d494; border-color: rgba(161,212,148,0.25); background: rgba(35,80,30,0.25); }
            .cal-allday-chip.secondary::before { background: #a1d494; }

            /* Featured "Next Up" card */
            .cal-featured-card {
                background: rgba(46,62,77,0.55);
                backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
                border-radius: 14px; padding: 16px 20px; margin-bottom: 10px;
                border-left: 3px solid #b8c8db; box-shadow: 0 8px 24px rgba(12,14,16,0.35);
            }
            .cal-featured-card.holiday { border-left-color: #ffb4ab; }
            .cal-featured-label {
                font-size: 10px; font-weight: 800; color: #b8c8db;
                text-transform: uppercase; letter-spacing: 0.2em; margin-bottom: 5px;
            }
            .cal-featured-title {
                font-size: 22px; font-weight: 700; color: #e2e2e5;
                letter-spacing: -0.02em; line-height: 1.1; margin-bottom: 7px;
            }
            .cal-featured-time { font-size: 13px; color: #c4c6cd; font-weight: 600; letter-spacing: 0.04em; margin-bottom: 3px; }
            .cal-featured-location { font-size: 11px; color: #9ca9b5; font-weight: 500; margin-top: 2px; }
            .cal-sidebar-event-location { font-size: 11px; color: #9ca9b5; font-weight: 500; margin-top: 2px; }

            /* Pill event rows */
            .cal-event-pill {
                display: flex; align-items: center;
                background: rgba(26,28,30,0.8); border-radius: 9999px;
                padding: 11px 18px; margin-bottom: 7px; transition: background 0.12s;
            }
            .cal-event-pill:hover { background: rgba(30,32,34,0.9); }
            .cal-event-pill:last-child { margin-bottom: 0; }
            .cal-pill-time {
                font-size: 11px; font-weight: 700; color: #c4c6cd;
                text-align: right; min-width: 62px; flex-shrink: 0;
                text-transform: uppercase; letter-spacing: 0.08em;
            }
            .cal-pill-divider { width: 1px; height: 18px; background: rgba(67,71,76,0.6); margin: 0 14px; flex-shrink: 0; }
            .cal-pill-title {
                font-size: 14px; font-weight: 600; color: #e2e2e5;
                flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; letter-spacing: -0.01em;
            }
            .cal-day-empty { color: #c4c6cd; font-size: 14px; font-weight: 500; text-align: center; padding: 56px 0; letter-spacing: 0.04em; }

            /* ════════════════════════════════════════════════════════════════════
               WEEK VIEW — large extralight date numbers, glass event cards
               ════════════════════════════════════════════════════════════════════ */
            .cal-grid-week {
                display: grid; grid-template-columns: repeat(7, 1fr);
                gap: 5px; flex: 1; min-height: 0; padding: 0 20px 10px 20px; overflow: hidden;
            }
            .cal-week-col {
                display: flex; flex-direction: column; border-radius: 10px; overflow: hidden;
                background: rgba(26,28,30,0.6); border: none; min-height: 0; cursor: pointer;
                -webkit-tap-highlight-color: transparent;
            }
            .cal-week-col:active { background: rgba(46,62,77,0.75); }
            .cal-week-col.today { background: rgba(26,40,52,0.7); }
            .cal-week-col-header { display: flex; flex-direction: column; align-items: center; padding: 10px 4px 8px 4px; flex-shrink: 0; }
            .cal-week-dow {
                font-size: 9px; font-weight: 800; text-transform: uppercase;
                letter-spacing: 0.15em; color: rgba(196,198,205,0.5); line-height: 1; margin-bottom: 3px;
            }
            .cal-week-col.today .cal-week-dow { color: #b8c8db; }
            .cal-week-date-num {
                font-size: 30px; font-weight: 200; letter-spacing: -0.04em;
                color: rgba(226,226,229,0.7); line-height: 1;
                width: auto; height: auto; border-radius: 0;
                background: none !important; box-shadow: none !important;
            }
            .cal-week-col.today .cal-week-date-num { color: #b8c8db; font-weight: 700; }
            .cal-week-today-label {
                font-size: 8px; font-weight: 800; color: #b8c8db;
                text-transform: uppercase; letter-spacing: 0.12em; margin-top: 2px; line-height: 1;
            }
            .cal-week-events {
                flex: 1; overflow-y: auto; padding: 4px 5px 6px 5px;
                display: flex; flex-direction: column; gap: 4px;
                -webkit-overflow-scrolling: touch; scrollbar-width: none;
            }
            .cal-week-events::-webkit-scrollbar { display: none; }
            .cal-week-event {
                display: flex; align-items: stretch; border-radius: 6px; overflow: hidden; flex-shrink: 0;
                background: rgba(51,53,55,0.45);
                backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border: none;
            }
            .cal-week-event-bar { width: 3px; background: #b8c8db; flex-shrink: 0; }
            .cal-week-event-bar.allday  { background: #a1d494; }
            .cal-week-event-bar.holiday { background: #ffb4ab; }
            .cal-week-event-inner { padding: 5px 6px; min-width: 0; flex: 1; overflow: hidden; }
            .cal-week-event-time {
                font-size: 8px; font-weight: 700; color: #c4c6cd;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.3;
                text-transform: uppercase; letter-spacing: 0.08em;
            }
            .cal-week-event-time.allday { color: #a1d494; }
            .cal-week-event-title { font-size: 15px; font-weight: 600; color: #e2e2e5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.3; }
            .cal-week-overflow { font-size: 8px; font-weight: 700; color: rgba(196,198,205,0.5); text-align: center; padding: 3px 0 2px 0; flex-shrink: 0; text-transform: uppercase; letter-spacing: 0.06em; }

            /* ════════════════════════════════════════════════════════════════════
               MONTH VIEW — glass grid (left) + Upcoming sidebar (right)
               ════════════════════════════════════════════════════════════════════ */
            .cal-month-header .cal-period-title { font-size: 22px; font-weight: 300; letter-spacing: -0.03em; color: #e2e2e5; text-align: left; }
            .cal-month-body { display: flex; gap: 12px; flex: 1; min-height: 0; padding: 0 20px 10px 20px; }
            .cal-month-main {
                flex: 1; display: flex; flex-direction: column; min-width: 0;
                background: rgba(26,28,30,0.55);
                backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
                border-radius: 14px; padding: 14px;
                outline: 1px solid rgba(142,145,151,0.12);
            }
            .cal-dow-row {
                display: grid; grid-template-columns: repeat(7, 1fr);
                text-align: center; margin-bottom: 6px; padding-bottom: 6px;
                border-bottom: 1px solid rgba(67,71,76,0.4);
            }
            .cal-dow-row div { font-size: 9px; font-weight: 800; color: #9ca9b5; text-transform: uppercase; letter-spacing: 0.12em; padding: 2px 0; }
            .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); flex: 1; gap: 2px; align-content: start; }
            .cal-day-cell {
                display: flex; flex-direction: column; align-items: center;
                padding: 4px 2px 3px 2px; border-radius: 7px; cursor: pointer;
                border: none; min-height: 48px; background: transparent; transition: background 0.12s;
                -webkit-tap-highlight-color: transparent; user-select: none;
            }
            .cal-day-cell:hover   { background: rgba(51,53,55,0.4); }
            .cal-day-cell:active  { background: rgba(51,53,55,0.65) !important; }
            .cal-day-cell.has-events { background: rgba(51,53,55,0.25); }
            .cal-day-cell.other-month { opacity: 0.18; cursor: default; pointer-events: none; }
            .cal-day-num {
                width: 26px; height: 26px; display: flex; align-items: center; justify-content: center;
                border-radius: 6px; font-size: 12px; font-weight: 500; color: #e2e2e5; margin-bottom: 4px; flex-shrink: 0;
            }
            .cal-day-cell.today .cal-day-num {
                background: #b8c8db; color: #223241; font-weight: 800;
                border-radius: 6px; box-shadow: 0 0 12px rgba(184,200,219,0.3);
            }
            .cal-day-cell.selected .cal-day-num { background: #2e3e4d; color: #b8c8db; }
            .cal-event-dots { display: flex; gap: 3px; flex-wrap: wrap; justify-content: center; max-width: 100%; }
            .cal-event-dot { width: 4px; height: 4px; border-radius: 50%; background: #b8c8db; opacity: 0.7; flex-shrink: 0; }
            .cal-event-dot.allday  { background: #a1d494; }
            .cal-event-dot.holiday { background: #ffb4ab; }
            .cal-event-more { font-size: 8px; font-weight: 700; color: #9ca9b5; line-height: 1; }

            /* Sidebar */
            .cal-month-sidebar { width: 220px; flex-shrink: 0; display: flex; flex-direction: column; overflow: hidden; }
            .cal-sidebar-heading { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
            .cal-sidebar-title { font-size: 14px; font-weight: 700; color: #b8c8db; letter-spacing: -0.01em; }
            .cal-sidebar-count { font-size: 9px; font-weight: 800; color: #9ca9b5; text-transform: uppercase; letter-spacing: 0.1em; }
            .cal-sidebar-events { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 7px; scrollbar-width: none; }
            .cal-sidebar-events::-webkit-scrollbar { display: none; }
            .cal-sidebar-event {
                display: flex; align-items: stretch;
                background: rgba(51,53,55,0.35);
                backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
                border-radius: 10px; overflow: hidden;
                outline: 1px solid rgba(142,145,151,0.12);
                border-left: 3px solid #b8c8db;
                box-shadow: 0 2px 8px rgba(12,14,16,0.2); flex-shrink: 0;
            }
            .cal-sidebar-event.allday  { border-left-color: #a1d494; }
            .cal-sidebar-event.holiday { border-left-color: #ffb4ab; }
            .cal-sidebar-event-inner { padding: 9px 11px; flex: 1; min-width: 0; }
            .cal-sidebar-event-date { font-size: 10px; font-weight: 700; color: #9ca9b5; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 2px; }
            .cal-sidebar-event-title { font-size: 13px; font-weight: 700; color: #e2e2e5; letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .cal-sidebar-event-time { font-size: 11px; color: #c4c6cd; font-weight: 500; margin-top: 2px; }

            /* ── Calendar photo background ──────────────────────────────────────── */
            .agenda-container {
                position: relative !important;
                overflow: hidden !important;
                background: transparent !important;
            }
            .cal-photo-bg {
                position: absolute; inset: 0; z-index: 0;
                pointer-events: none; overflow: hidden;
            }
            .cal-photo-img {
                position: absolute; inset: 0;
                width: 100%; height: 100%; object-fit: cover;
                transition: opacity 1.8s ease-in-out;
            }
            .cal-photo-img.cal-photo-hidden { opacity: 0; }
            .cal-photo-overlay {
                position: absolute; inset: 0;
                background:
                    linear-gradient(to top,
                        rgba(12,14,16,0.88) 0%,
                        rgba(12,14,16,0.45) 35%,
                        rgba(12,14,16,0.22) 70%,
                        rgba(12,14,16,0.18) 100%);
            }
            /* Ensure all calendar chrome sits above the photo layer */
            .agenda-header,
            .cal-month-view, .cal-week-view, .cal-day-view {
                position: relative; z-index: 1;
            }
            .cal-ambient-shortcut-btn { z-index: 10; }
        `;
        document.head.appendChild(style);
    }

    // ── View switching ───────────────────────────────────────────────────────

    /**
     * Central view switcher. Hides all three containers, shows the requested one,
     * updates the toggle button, loads data, and starts the auto-return timer.
     */
    showCalendarView(mode) {
        this.calendarViewMode = mode;

        // Hide the legacy rolling-agenda element — never shown in three-view system
        if (this.domCache.agendaContent) {
            this.domCache.agendaContent.style.display = 'none';
        }

        const mv = document.getElementById('calendarMonthView');
        const wv = document.getElementById('calendarWeekView');
        const dv = document.getElementById('calendarDayView');
        if (mv) mv.style.display = mode === 'month' ? 'flex' : 'none';
        if (wv) wv.style.display = mode === 'week'  ? 'flex' : 'none';
        if (dv) dv.style.display = mode === 'day'   ? 'flex' : 'none';

        document.querySelectorAll('.cal-toggle-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === mode);
        });

        if (mode === 'month') {
            this.loadMonthEvents();
        } else if (mode === 'week') {
            this.calendarMonthDate = new Date(this.calendarWeekStart);
            this.loadMonthEvents();
        } else if (mode === 'day') {
            // Always fetch fresh data — calendarMonthEvents starts empty on boot
            this.calendarMonthDate = new Date(this.calendarDayDate);
            this.loadMonthEvents();
        }

        this.startCalendarAutoReturn();
    }

    enterMonthView() { this.showCalendarView('month'); }
    enterDayView(date) { this.calendarDayDate = date; this.showCalendarView('day'); }

    /**
     * Auto-return target: reset all state to today, hide views.
     * Card 4 will re-enter Week view on next visit via goToCard(4) → showCalendarView('week').
     */
    exitToDefaultView() {
        this.clearCalendarAutoReturn();
        this.calendarDayDate   = new Date();
        this.calendarWeekStart = this._weekStartFor(new Date());
        this.calendarMonthDate = new Date();
        ['calendarMonthView','calendarWeekView','calendarDayView'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
        if (this.domCache.agendaContent) {
            this.domCache.agendaContent.style.display = 'none';
        }
    }

    exitToAgendaView() { this.exitToDefaultView(); }

    // ── Month navigation ─────────────────────────────────────────────────────

    navigateMonth(direction) {
        const d = new Date(this.calendarMonthDate);
        d.setDate(1);
        d.setMonth(d.getMonth() + direction);
        this.calendarMonthDate = d;
        this.loadMonthEvents();
    }

    // ── Data loading ─────────────────────────────────────────────────────────

    async loadMonthEvents() {
        const year  = this.calendarMonthDate.getFullYear();
        const month = this.calendarMonthDate.getMonth(); // 0-indexed
        const lastDay = new Date(year, month + 1, 0).getDate();

        const pad  = (n) => String(n).padStart(2, '0');
        const startStr = `${year}-${pad(month + 1)}-01`;
        const endStr   = `${year}-${pad(month + 1)}-${pad(lastDay)}`;

        try {
            const response = await fetch(`/api/calendar/agenda?start=${startStr}&end=${endStr}`);
            if (response.status === 503) {
                this.calendarMonthEvents = [];
            } else {
                this.calendarMonthEvents = await response.json();
            }
        } catch (e) {
            console.error('loadMonthEvents error:', e);
            this.calendarMonthEvents = [];
        }

        // After data loads, render whichever view is currently active
        if (this.calendarViewMode === 'month') {
            this.renderMonthGrid();
        } else if (this.calendarViewMode === 'week') {
            this.renderWeekGrid();
        } else if (this.calendarViewMode === 'day') {
            this.renderDayView(this.calendarDayDate);
        }
    }

    // ── Renderers ────────────────────────────────────────────────────────────

    renderMonthGrid() {
        const year  = this.calendarMonthDate.getFullYear();
        const month = this.calendarMonthDate.getMonth();

        const titleEl = document.getElementById('calMonthTitle');
        if (titleEl) {
            titleEl.textContent = this.calendarMonthDate.toLocaleDateString('en-US', {
                month: 'long', year: 'numeric'
            });
        }

        const grid = document.getElementById('calGrid');
        if (!grid) return;

        const firstDOW    = new Date(year, month, 1).getDay();       // 0=Sun
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const prevDays    = new Date(year, month, 0).getDate();       // days in prev month
        const now         = new Date();
        const todayKey    = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;

        // Build event lookup: "Y-M-D" → array of events (raw month index, no padding)
        const byDay = {};
        (this.calendarMonthEvents || []).forEach(event => {
            let d;
            if (event.start.dateTime) {
                d = new Date(event.start.dateTime);
            } else {
                const p = event.start.date.split('-');
                d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
            }
            const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
            if (!byDay[key]) byDay[key] = [];
            byDay[key].push(event);
        });

        let html = '';

        // Leading cells (prev month)
        for (let i = firstDOW - 1; i >= 0; i--) {
            html += `<div class="cal-day-cell other-month">
                         <div class="cal-day-num">${prevDays - i}</div>
                     </div>`;
        }

        // Current month cells
        for (let day = 1; day <= daysInMonth; day++) {
            const dayKey   = `${year}-${month}-${day}`;
            const isToday  = dayKey === todayKey;
            const evts     = byDay[dayKey] || [];
            const pad      = (n) => String(n).padStart(2, '0');
            const dateAttr = `${year}-${pad(month + 1)}-${pad(day)}`;

            let dotsHtml = '';
            if (evts.length > 0) {
                evts.slice(0, 3).forEach(evt => {
                    let cls = 'cal-event-dot';
                    if (!evt.start.dateTime)                                              cls += ' allday';
                    if (evt.summary && /holiday/i.test(evt.summary))                     cls += ' holiday';
                    dotsHtml += `<div class="${cls}"></div>`;
                });
                if (evts.length > 3) dotsHtml += `<div class="cal-event-more">+${evts.length - 3}</div>`;
            }

            let cellCls = 'cal-day-cell';
            if (isToday)      cellCls += ' today';
            if (evts.length)  cellCls += ' has-events';

            html += `<div class="${cellCls}" data-date="${dateAttr}">
                         <div class="cal-day-num">${day}</div>
                         <div class="cal-event-dots">${dotsHtml}</div>
                     </div>`;
        }

        // Trailing cells (next month)
        const totalCells = firstDOW + daysInMonth;
        const trailing   = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
        for (let d = 1; d <= trailing; d++) {
            html += `<div class="cal-day-cell other-month">
                         <div class="cal-day-num">${d}</div>
                     </div>`;
        }

        grid.innerHTML = html;
        // Tap listener is delegated from setupCalendarGrid — no per-render binding needed.
        this.renderMonthSidebar();
    }

    /** Populate the Upcoming sidebar with events from today onward, max 7. */
    renderMonthSidebar() {
        const sidebar = document.getElementById('calMonthSidebar');
        const countEl = document.getElementById('calSidebarCount');
        if (!sidebar) return;

        const today = new Date(); today.setHours(0, 0, 0, 0);

        const upcoming = (this.calendarMonthEvents || []).filter(ev => {
            const d = ev.start.dateTime
                ? new Date(ev.start.dateTime)
                : (() => { const p = ev.start.date.split('-'); return new Date(+p[0], +p[1]-1, +p[2]); })();
            return d >= today;
        }).sort((a, b) => {
            const da = a.start.dateTime ? new Date(a.start.dateTime) : (() => { const p = a.start.date.split('-'); return new Date(+p[0],+p[1]-1,+p[2]); })();
            const db = b.start.dateTime ? new Date(b.start.dateTime) : (() => { const p = b.start.date.split('-'); return new Date(+p[0],+p[1]-1,+p[2]); })();
            return da - db;
        }).slice(0, 7);

        if (countEl) countEl.textContent = `${upcoming.length} events`;

        let html = '';
        upcoming.forEach(ev => {
            const isAD  = !ev.start.dateTime;
            const isHol = /holiday/i.test(ev.summary || '');
            let cls = 'cal-sidebar-event';
            if (isHol) cls += ' holiday';
            else if (isAD) cls += ' allday';

            const d = isAD
                ? (() => { const p = ev.start.date.split('-'); return new Date(+p[0], +p[1]-1, +p[2]); })()
                : new Date(ev.start.dateTime);

            const dateStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            const timeStr = isAD ? 'All day'
                : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
            const locHtml = ev.location
                ? `<div class="cal-sidebar-event-location">📍 ${ev.location}</div>` : '';

            html += `<div class="${cls}">
                <div class="cal-sidebar-event-inner">
                    <div class="cal-sidebar-event-date">${dateStr}</div>
                    <div class="cal-sidebar-event-title">${ev.summary || '(No title)'}</div>
                    <div class="cal-sidebar-event-time">${timeStr}</div>
                    ${locHtml}
                </div>
            </div>`;
        });

        sidebar.innerHTML = html || '<div style="color:#9ca9b5;font-size:12px;padding:8px 0">No upcoming events</div>';
    }

    /** Render Variant C single-line event rows for the day view. */
    renderDayView(date) {
        // Update sub-header title
        const titleEl = document.getElementById('calDayTitle');
        if (titleEl) {
            titleEl.textContent = date.toLocaleDateString('en-US', {
                weekday: 'long', month: 'long', day: 'numeric'
            });
        }

        // Prev arrow disabled when date is today (no past navigation)
        const today    = new Date();
        const isToday  = date.toDateString() === today.toDateString();
        const prevBtn  = document.getElementById('calPrevDay');
        const nextBtn  = document.getElementById('calNextDay');
        if (prevBtn) prevBtn.classList.toggle('disabled', isToday);
        if (nextBtn) nextBtn.classList.remove('disabled'); // always enabled forward

        // Filter events for this day from the loaded month window
        const dayKey    = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
        const dayEvents = (this.calendarMonthEvents || []).filter(event => {
            const d = event.start.dateTime
                ? new Date(event.start.dateTime)
                : (() => { const p = event.start.date.split('-'); return new Date(+p[0], +p[1]-1, +p[2]); })();
            return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` === dayKey;
        });

        // Sort: all-day first, then chronological
        dayEvents.sort((a, b) => {
            const aAD = !a.start.dateTime, bAD = !b.start.dateTime;
            if (aAD && !bAD) return -1;
            if (!aAD && bAD) return  1;
            return new Date(a.start.dateTime || a.start.date)
                 - new Date(b.start.dateTime || b.start.date);
        });

        const el = document.getElementById('calDayEvents');
        if (!el) return;

        if (dayEvents.length === 0) {
            el.innerHTML = '<div class="cal-day-empty">Nothing on the calendar for this day.</div>';
            return;
        }

        const allDayEvts = dayEvents.filter(e => !e.start.dateTime);
        const timedEvts  = dayEvents.filter(e =>  e.start.dateTime);

        let html = '';

        // ── All-day chips
        if (allDayEvts.length) {
            html += '<div class="cal-allday-strip">';
            allDayEvts.forEach(ev => {
                const isHol = /holiday/i.test(ev.summary || '');
                const cls   = isHol ? 'cal-allday-chip holiday' : 'cal-allday-chip secondary';
                html += `<div class="${cls}">${ev.summary || '(No title)'}</div>`;
            });
            html += '</div>';
        }

        // ── Featured "Next Up" card
        // For today: pick the first event that hasn't ended yet (in-progress counts).
        // For other days: always pick the first timed event.
        const now = new Date();
        let featIdx = 0;
        if (isToday && timedEvts.length) {
            const upcoming = timedEvts.findIndex(ev => new Date(ev.end.dateTime) > now);
            if (upcoming !== -1) featIdx = upcoming;
        }

        let remaining = [...timedEvts];
        if (timedEvts.length) {
            const feat  = timedEvts[featIdx];
            remaining   = [...timedEvts.slice(0, featIdx), ...timedEvts.slice(featIdx + 1)];
            const isHol = /holiday/i.test(feat.summary || '');
            const s     = new Date(feat.start.dateTime);
            const e     = new Date(feat.end.dateTime);
            const ts    = s.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
            const te    = e.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
            const loc   = feat.location ? `<div class="cal-featured-location">📍 ${feat.location}</div>` : '';
            const label = (isToday && new Date(feat.start.dateTime) <= now) ? 'In Progress' : 'Next Up';
            html += `<div class="cal-featured-card${isHol ? ' holiday' : ''}">
                <div class="cal-featured-label">${label}</div>
                <div class="cal-featured-title">${feat.summary || '(No title)'}</div>
                <div class="cal-featured-time">${ts} — ${te}</div>${loc}
            </div>`;
        }

        // ── Pill rows for remaining timed events
        remaining.forEach(ev => {
            const s  = new Date(ev.start.dateTime);
            const ts = s.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
            html += `<div class="cal-event-pill">
                <div class="cal-pill-time">${ts}</div>
                <div class="cal-pill-divider"></div>
                <div class="cal-pill-title">${ev.summary || '(No title)'}</div>
            </div>`;
        });

        el.innerHTML = html;
    }

    /** Render the 7-column week grid for calendarWeekStart. */
    renderWeekGrid() {
        const ws     = this.calendarWeekStart; // Sunday
        const today  = new Date();
        const DOW    = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        const pad    = (n) => String(n).padStart(2, '0');

        // Build event lookup by day key for the 7-day window
        const byDay = {};
        (this.calendarMonthEvents || []).forEach(event => {
            const d = event.start.dateTime
                ? new Date(event.start.dateTime)
                : (() => { const p = event.start.date.split('-'); return new Date(+p[0], +p[1]-1, +p[2]); })();
            const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
            if (!byDay[key]) byDay[key] = [];
            byDay[key].push(event);
        });

        // Week title
        const we = new Date(ws); we.setDate(we.getDate() + 6);
        const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const titleEl = document.getElementById('calWeekTitle');
        if (titleEl) titleEl.textContent = `${fmt(ws)} – ${fmt(we)}, ${we.getFullYear()}`;

        // Prev week disabled if the week contains today (can't go before current week)
        const prevBtn = document.getElementById('calPrevWeek');
        const nextBtn = document.getElementById('calNextWeek');
        const wsTime  = ws.getTime();
        const todayWS = this._weekStartFor(today).getTime();
        if (prevBtn) prevBtn.classList.toggle('disabled', wsTime <= todayWS);
        if (nextBtn) nextBtn.classList.remove('disabled');

        // Build columns
        const grid = document.getElementById('calWeekGrid');
        if (!grid) return;

        let html = '';
        for (let i = 0; i < 7; i++) {
            const d   = new Date(ws); d.setDate(d.getDate() + i);
            const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
            const isT = d.toDateString() === today.toDateString();
            const evts = (byDay[key] || []).sort((a, b) => {
                const aAD = !a.start.dateTime, bAD = !b.start.dateTime;
                if (aAD && !bAD) return -1; if (!aAD && bAD) return 1;
                return new Date(a.start.dateTime||a.start.date) - new Date(b.start.dateTime||b.start.date);
            });

            const MAX_VISIBLE = 4;
            let evtHtml = '';
            evts.slice(0, MAX_VISIBLE).forEach(evt => {
                const isAllDay = !evt.start.dateTime;
                const timeStr  = isAllDay
                    ? 'All day'
                    : new Date(evt.start.dateTime).toLocaleTimeString('en-US', {
                          hour: 'numeric', minute: '2-digit', hour12: true
                      });
                let barCls = 'cal-week-event-bar';
                if (isAllDay) barCls += ' allday';
                if (evt.summary && /holiday/i.test(evt.summary)) barCls = 'cal-week-event-bar holiday';

                evtHtml += `<div class="cal-week-event">
                    <div class="${barCls}"></div>
                    <div class="cal-week-event-inner">
                        <div class="cal-week-event-time${isAllDay ? ' allday' : ''}">${timeStr}</div>
                        <div class="cal-week-event-title">${evt.summary || '(No title)'}</div>
                    </div>
                </div>`;
            });
            if (evts.length > MAX_VISIBLE) {
                evtHtml += `<div class="cal-week-overflow">+${evts.length - MAX_VISIBLE} more</div>`;
            }

            const todayLabel = isT ? '<div class="cal-week-today-label">Today</div>' : '';
            const dateKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
            html += `<div class="cal-week-col${isT ? ' today' : ''}" data-date="${dateKey}">
                <div class="cal-week-col-header">
                    <span class="cal-week-dow">${DOW[i]}</span>
                    <span class="cal-week-date-num">${d.getDate()}</span>
                    ${todayLabel}
                </div>
                <div class="cal-week-events">${evtHtml}</div>
            </div>`;
        }

        grid.innerHTML = html;
    }

    // ── Day / Week navigation ─────────────────────────────────────────────────

    navigateDay(dir) {
        const d = new Date(this.calendarDayDate);
        d.setDate(d.getDate() + dir);
        // Hard floor at today — no past navigation
        const today = new Date(); today.setHours(0,0,0,0);
        if (d < today) return;
        this.calendarDayDate = d;
        // If the new day is in a different month, reload events
        if (d.getMonth() !== this.calendarMonthDate.getMonth() ||
            d.getFullYear() !== this.calendarMonthDate.getFullYear()) {
            this.calendarMonthDate = new Date(d);
            this.loadMonthEvents();
        } else {
            this.renderDayView(d);
        }
    }

    navigateWeek(dir) {
        const ws = new Date(this.calendarWeekStart);
        ws.setDate(ws.getDate() + dir * 7);
        // Floor at current week
        const todayWS = this._weekStartFor(new Date());
        if (ws < todayWS) return;
        this.calendarWeekStart = ws;
        this.calendarMonthDate = new Date(ws);
        this.loadMonthEvents();
    }

    // ── Auto-return timer ────────────────────────────────────────────────────

    startWeatherAutoReturn() {
        this.clearWeatherAutoReturn();
        const bar = document.getElementById('wxReturnProgress');
        if (bar) {
            bar.style.transition = 'none';
            bar.style.width = '100%';
            requestAnimationFrame(() => requestAnimationFrame(() => {
                bar.style.transition = `width ${this.CALENDAR_AUTO_RETURN_MS}ms linear`;
                bar.style.width = '0%';
            }));
        }
        this.weatherAutoReturnTimer = setTimeout(() => {
            this.goToCard(0);
        }, this.CALENDAR_AUTO_RETURN_MS);
    }

    clearWeatherAutoReturn() {
        if (this.weatherAutoReturnTimer) {
            clearTimeout(this.weatherAutoReturnTimer);
            this.weatherAutoReturnTimer = null;
        }
        const bar = document.getElementById('wxReturnProgress');
        if (bar) {
            bar.style.transition = 'none';
            bar.style.width = '100%';
        }
    }

    /**
     * Start (or restart) the inactivity timer. The progress bar animates from
     * full → empty over CALENDAR_AUTO_RETURN_MS, then returns to Card 0.
     */
    startCalendarAutoReturn() {
        this.clearCalendarAutoReturn();

        // Animate the progress bar in whichever view is currently visible
        ['calReturnProgress', 'calWeekReturnProgress', 'calDayReturnProgress'].forEach(id => {
            const bar = document.getElementById(id);
            if (!bar) return;
            bar.style.transition = 'none';
            bar.style.width = '100%';
            requestAnimationFrame(() => requestAnimationFrame(() => {
                bar.style.transition = `width ${this.CALENDAR_AUTO_RETURN_MS}ms linear`;
                bar.style.width = '0%';
            }));
        });

        this.calendarAutoReturnTimer = setTimeout(() => {
            this.exitToDefaultView();
            this.goToCard(0);
        }, this.CALENDAR_AUTO_RETURN_MS);
    }

    clearCalendarAutoReturn() {
        if (this.calendarAutoReturnTimer) {
            clearTimeout(this.calendarAutoReturnTimer);
            this.calendarAutoReturnTimer = null;
        }
    }

    /**
     * Call on any user interaction within the calendar views to reset the timer.
     * No-op when already in rolling agenda mode.
     */
    resetCalendarAutoReturn() {
        // Always valid to reset — three-view system is always the active UI on Card 4
        this.startCalendarAutoReturn();
    }
}

// Initialize the smart display when the page loads
let smartDisplay;
document.addEventListener('DOMContentLoaded', () => {
    smartDisplay = new SmartDisplay();
});
