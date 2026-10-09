        /*
         * =========================================================
         * CONFIGURATION
         * =========================================================
         *
         * Recommended production setup:
         *
         *     const API_BASE = '/api';
         *
         * This assumes your frontend and API are behind the same
         * domain/reverse proxy.
         *
         * Development with a separate backend:
         *
         *     const API_BASE = 'http://localhost:3000/api';
         */

        const API_BASE = '/api';


        /*
         * =========================================================
         * STATE
         * =========================================================
         */

        let selectedPackage = null;


        /*
         * =========================================================
         * INITIALIZE
         * =========================================================
         */

        document.addEventListener(
            'DOMContentLoaded',
            initializeApp
        );


        async function initializeApp() {

            console.log('FastWiFi application starting...');

            setupEventListeners();

            await loadPackages();

        }


        /*
         * =========================================================
         * EVENT LISTENERS
         * =========================================================
         */

        function setupEventListeners() {

            /*
             * Payment form
             */

            const paymentForm =
                document.getElementById('paymentForm');

            paymentForm.addEventListener(
                'submit',
                handlePaymentSubmit
            );


            /*
             * Phone input
             */

            const phoneInput =
                document.getElementById('phoneNumber');

            phoneInput.addEventListener(
                'input',
                handlePhoneInput
            );


            /*
             * Package selection
             *
             * Event delegation means we don't need to attach
             * separate listeners every time packages are rendered.
             */

            const packagesContainer =
                document.getElementById('packagesContainer');

            packagesContainer.addEventListener(
                'click',
                handlePackageClick
            );

        }


        /*
         * =========================================================
         * LOAD PACKAGES
         * =========================================================
         */

        async function loadPackages() {

            const container =
                document.getElementById('packagesContainer');


            showPackagesLoading();


            try {

                console.log(
                    `Loading packages from ${API_BASE}/pricing`
                );


                const response =
                    await fetch(
                        `${API_BASE}/pricing`,
                        {
                            method: 'GET',
                            headers: {
                                'Accept': 'application/json'
                            }
                        }
                    );


                console.log(
                    'Pricing API status:',
                    response.status
                );


                if (!response.ok) {

                    throw new Error(
                        `Pricing API returned HTTP ${response.status}`
                    );

                }


                const data =
                    await response.json();


                console.log(
                    'Pricing API response:',
                    data
                );


                /*
                 * Support both API response formats:
                 *
                 * Format 1:
                 *
                 * [
                 *     {...},
                 *     {...}
                 * ]
                 *
                 * Format 2:
                 *
                 * {
                 *     "success": true,
                 *     "packages": [...]
                 * }
                 */

                let packages;


                if (Array.isArray(data)) {

                    packages = data;

                } else if (
                    data &&
                    Array.isArray(data.packages)
                ) {

                    packages = data.packages;

                } else {

                    throw new Error(
                        'API response does not contain a packages array'
                    );

                }


                console.log(
                    `Received ${packages.length} packages`
                );


                renderPackages(packages);

            } catch (error) {

                console.error(
                    'Failed to load packages:',
                    error
                );


                /*
                 * IMPORTANT:
                 *
                 * Don't leave the package area empty.
                 * Load demo/fallback packages.
                 */

                console.log(
                    'API unavailable. Loading fallback packages.'
                );


                loadDemoPackages();


                /*
                 * Don't show an ugly error if the fallback
                 * packages successfully render.
                 */

                console.warn(
                    'Using fallback package data.'
                );

            }

        }


        /*
         * =========================================================
         * RENDER PACKAGES
         * =========================================================
         */

        function renderPackages(packages) {

            const container =
                document.getElementById('packagesContainer');


            if (!container) {

                console.error(
                    '#packagesContainer was not found.'
                );

                return;

            }


            /*
             * Make sure we actually received an array.
             */

            if (!Array.isArray(packages)) {

                console.error(
                    'renderPackages expected an array:',
                    packages
                );

                showPackagesError(
                    'Invalid package data received.'
                );

                return;

            }


            /*
             * Normalize package data.
             *
             * This protects against APIs returning:
             *
             * hours: "1"
             *
             * instead of:
             *
             * hours: 1
             */

            const normalizedPackages =
                packages
                    .map(normalizePackage)
                    .filter(Boolean);


            console.log(
                'Normalized packages:',
                normalizedPackages
            );


            /*
             * Desired packages.
             */

            const targetHours =
                [1, 6, 12, 24];


            /*
             * Filter the preferred plans.
             */

            const filteredPackages =
                normalizedPackages
                    .filter(pkg =>
                        targetHours.includes(pkg.hours)
                    )
                    .sort((a, b) =>
                        a.hours - b.hours
                    );


            /*
             * If the preferred packages exist,
             * show them.
             *
             * Otherwise show up to four packages
             * returned by the API.
             */

            const displayPackages =
                filteredPackages.length > 0
                    ? filteredPackages
                    : normalizedPackages.slice(0, 4);


            /*
             * No packages.
             */

            if (displayPackages.length === 0) {

                showPackagesEmpty();

                return;

            }


            /*
             * Generate cards.
             */

            container.innerHTML =
                displayPackages
                    .map(createPackageCard)
                    .join('');


            console.log(
                `Rendered ${displayPackages.length} package cards.`
            );

        }


        /*
         * =========================================================
         * NORMALIZE PACKAGE
         * =========================================================
         */

        function normalizePackage(pkg) {

            if (!pkg || typeof pkg !== 'object') {

                return null;

            }


            const hours =
                Number(pkg.hours);


            const price =
                Number(pkg.price);


            /*
             * Validate required values.
             */

            if (
                !Number.isFinite(hours) ||
                !Number.isFinite(price)
            ) {

                console.warn(
                    'Skipping invalid package:',
                    pkg
                );

                return null;

            }


            return {

                id:
                    pkg.id ??
                    pkg.package_id ??
                    crypto.randomUUID(),

                hours,

                price,

                description:
                    pkg.description ||
                    `${hours} Hours`

            };

        }


        /*
         * =========================================================
         * CREATE PACKAGE CARD
         * =========================================================
         */

        function createPackageCard(pkg) {

            const popularBadge =
                pkg.hours >= 24
                    ? `
                        <div class="package-badge">
                            ⭐ Popular
                        </div>
                    `
                    : '';


            return `

                <div
                    class="package-card"
                    data-id="${escapeHtml(pkg.id)}"
                    data-price="${pkg.price}"
                    data-hours="${pkg.hours}"
                    data-description="${escapeHtml(pkg.description)}"
                >

                    ${popularBadge}


                    <div class="package-duration">
                        ${pkg.hours}h
                    </div>


                    <div class="package-duration-label">
                        ${escapeHtml(pkg.description)}
                    </div>


                    <div class="package-price">
                        KES ${formatCurrency(pkg.price)}
                    </div>


                    <div class="package-price-label">
                        One-time
                    </div>


                    <ul class="package-features">

                        <li>
                            High-speed
                        </li>

                        <li>
                            ${pkg.hours}h access
                        </li>

                        <li>
                            Unlimited data
                        </li>

                    </ul>


                    <button
                        type="button"
                        class="package-select-btn"
                    >
                        SELECT
                    </button>

                </div>

            `;

        }


        /*
         * =========================================================
         * PACKAGE CLICK
         * =========================================================
         */

        function handlePackageClick(event) {

            const card =
                event.target.closest('.package-card');


            if (!card) {

                return;

            }


            selectPackage(card);

        }


        /*
         * =========================================================
         * SELECT PACKAGE
         * =========================================================
         */

        function selectPackage(card) {

            /*
             * Remove previous selection.
             */

            document
                .querySelectorAll('.package-card')
                .forEach(existingCard => {

                    existingCard.classList.remove(
                        'selected'
                    );

                });


            /*
             * Select current card.
             */

            card.classList.add('selected');


            /*
             * Store selected package.
             */

            selectedPackage = {

                id:
                    card.dataset.id,

                hours:
                    Number(card.dataset.hours),

                price:
                    Number(card.dataset.price),

                description:
                    card.dataset.description

            };


            console.log(
                'Selected package:',
                selectedPackage
            );


            /*
             * Update display.
             */

            updateSelectedPackageDisplay();

        }


        /*
         * =========================================================
         * SELECTED PACKAGE DISPLAY
         * =========================================================
         */

        function updateSelectedPackageDisplay() {

            const display =
                document.getElementById(
                    'selectedPackageDisplay'
                );


            if (!selectedPackage) {

                display.innerHTML = `

                    <span class="selected-package-text">
                        Selected Package
                    </span>

                    <span class="selected-package-value selected-package-none">
                        None Selected
                    </span>

                `;

                return;

            }


            display.innerHTML = `

                <span class="selected-package-text">
                    ✓ Selected Package
                </span>

                <span class="selected-package-value">
                    ${selectedPackage.hours}h -
                    KES ${formatCurrency(selectedPackage.price)}
                </span>

            `;

        }


        /*
         * =========================================================
         * PAYMENT FORM
         * =========================================================
         */

        async function handlePaymentSubmit(event) {

            event.preventDefault();


            /*
             * Package validation.
             */

            if (!selectedPackage) {

                showMessage(
                    'Please select a package first.',
                    'error'
                );

                return;

            }


            /*
             * Get phone number.
             */

            const phoneInput =
                document.getElementById('phoneNumber');


            const phoneNumber =
                phoneInput.value.trim();


            /*
             * Format phone number.
             */

            const formattedPhone =
                formatPhoneNumber(phoneNumber);


            if (!formattedPhone) {

                showMessage(
                    'Please enter a valid Kenyan phone number.',
                    'error'
                );

                return;

            }


            /*
             * Start payment.
             */

            await initiatePayment(
                formattedPhone,
                selectedPackage.price
            );

        }


        /*
         * =========================================================
         * PHONE FORMATTING
         * =========================================================
         */

        function handlePhoneInput(event) {

            let value =
                event.target.value.replace(/\D/g, '');


            /*
             * Convert:
             *
             * 0712345678
             *
             * into:
             *
             * 254712345678
             */

            if (
                value.startsWith('0') &&
                value.length > 1
            ) {

                value =
                    '254' +
                    value.substring(1);

            }


            /*
             * Limit to 12 digits.
             */

            value =
                value.substring(0, 12);


            event.target.value =
                value;

        }


        function formatPhoneNumber(phoneNumber) {

            let phone =
                phoneNumber
                    .replace(/\D/g, '');


            /*
             * 0712345678
             */

            if (
                phone.startsWith('0') &&
                phone.length === 10
            ) {

                phone =
                    '254' +
                    phone.substring(1);

            }


            /*
             * 712345678
             */

            else if (
                phone.startsWith('7') &&
                phone.length === 9
            ) {

                phone =
                    '254' +
                    phone;

            }


            /*
             * 254712345678
             */

            if (
                /^2547\d{8}$/.test(phone)
            ) {

                return phone;

            }


            return null;

        }


        /*
         * =========================================================
         * INITIATE PAYMENT
         * =========================================================
         */

        async function initiatePayment(
            phoneNumber,
            amount
        ) {

            const submitBtn =
                document.getElementById('submitBtn');


            const originalText =
                submitBtn.textContent;


            try {

                submitBtn.disabled = true;

                submitBtn.textContent =
                    'Processing...';


                showMessage(
                    '📱 Sending M-Pesa prompt to your phone...',
                    'loading'
                );


                /*
                 * Register user.
                 */

                const registerRes =
                    await fetch(
                        `${API_BASE}/auth/register`,
                        {
                            method: 'POST',

                            headers: {
                                'Content-Type':
                                    'application/json',

                                'Accept':
                                    'application/json'
                            },

                            body: JSON.stringify({
                                phone_number:
                                    phoneNumber
                            })
                        }
                    );


                if (!registerRes.ok) {

                    throw new Error(
                        `Registration failed (${registerRes.status})`
                    );

                }


                const registerData =
                    await registerRes.json();


                console.log(
                    'Registration response:',
                    registerData
                );


                if (
                    !registerData.success ||
                    !registerData.token
                ) {

                    throw new Error(
                        registerData.error ||
                        'Registration failed'
                    );

                }


                const token =
                    registerData.token;


                /*
                 * Initiate payment.
                 */

                const paymentRes =
                    await fetch(
                        `${API_BASE}/payment/initiate`,
                        {
                            method: 'POST',

                            headers: {
                                'Content-Type':
                                    'application/json',

                                'Accept':
                                    'application/json',

                                'Authorization':
                                    `Bearer ${token}`
                            },

                            body: JSON.stringify({

                                phone_number:
                                    phoneNumber,

                                amount:
                                    amount

                            })
                        }
                    );


                if (!paymentRes.ok) {

                    throw new Error(
                        `Payment request failed (${paymentRes.status})`
                    );

                }


                const paymentData =
                    await paymentRes.json();


                console.log(
                    'Payment response:',
                    paymentData
                );


                if (!paymentData.success) {

                    throw new Error(
                        paymentData.error ||
                        'Payment initiation failed'
                    );

                }


                /*
                 * Payment request succeeded.
                 */

                showMessage(
                    `✅ M-Pesa prompt sent to ${phoneNumber}.

💬 Check your phone and enter your M-Pesa PIN to complete the payment.

Your WiFi will be activated immediately after payment.`,
                    'success'
                );


                /*
                 * Store authentication information.
                 */

                localStorage.setItem(
                    'authToken',
                    token
                );


                localStorage.setItem(
                    'selectedPackageId',
                    selectedPackage.id
                );


                /*
                 * Redirect after payment.
                 *
                 * Change this to your actual portal URL.
                 */

                setTimeout(() => {

                    window.location.href =
                        '/portal';

                }, 3000);


            } catch (error) {

                console.error(
                    'Payment error:',
                    error
                );


                showMessage(
                    `❌ Error: ${error.message}

Please try again or contact support.`,
                    'error'
                );


                submitBtn.disabled = false;

                submitBtn.textContent =
                    originalText;

            }

        }


        /*
         * =========================================================
         * STATUS MESSAGE
         * =========================================================
         */

        function showMessage(
            text,
            type
        ) {

            const messageDiv =
                document.getElementById(
                    'statusMessage'
                );


            messageDiv.className =
                `status-message ${type}`;


            if (type === 'loading') {

                messageDiv.innerHTML = `

                    <span class="loading-spinner"></span>

                    <span>
                        ${escapeHtml(text)}
                    </span>

                `;

            } else {

                messageDiv.textContent =
                    text;

            }

        }


        /*
         * =========================================================
         * PACKAGE UI STATES
         * =========================================================
         */

        function showPackagesLoading() {

            const container =
                document.getElementById(
                    'packagesContainer'
                );


            container.innerHTML = `

                <div class="packages-loading">

                    <div class="packages-loading-spinner"></div>

                    <p>
                        Loading WiFi packages...
                    </p>

                </div>

            `;

        }


        function showPackagesEmpty() {

            const container =
                document.getElementById(
                    'packagesContainer'
                );


            container.innerHTML = `

                <div class="packages-empty">

                    <h3>
                        No packages available
                    </h3>

                    <p>
                        Please try again later.
                    </p>

                </div>

            `;

        }


        function showPackagesError(message) {

            const container =
                document.getElementById(
                    'packagesContainer'
                );


            container.innerHTML = `

                <div class="packages-empty">

                    <h3>
                        Unable to load packages
                    </h3>

                    <p>
                        ${escapeHtml(message)}
                    </p>

                </div>

            `;

        }


        /*
         * =========================================================
         * DEMO / FALLBACK PACKAGES
         * =========================================================
         *
         * These packages are used when the pricing API cannot
         * be reached.
         */

        function loadDemoPackages() {

            const demoPackages = [

                {
                    id: 1,
                    hours: 1,
                    price: 5,
                    description: '1 Hour'
                },

                {
                    id: 2,
                    hours: 6,
                    price: 10,
                    description: '6 Hours'
                },

                {
                    id: 3,
                    hours: 12,
                    price: 20,
                    description: '12 Hours'
                },

                {
                    id: 4,
                    hours: 24,
                    price: 50,
                    description: '24 Hours'
                }

            ];


            renderPackages(
                demoPackages
            );

        }


        /*
         * =========================================================
         * HELPERS
         * =========================================================
         */

        function formatCurrency(value) {

            return Number(value).toLocaleString(
                'en-KE'
            );

        }


        function escapeHtml(value) {

            return String(value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');

        }

    