import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { getWallpaperPromptColor } from '../main/alphaManager.js';
import { getChromeAlpha, getPromptMessageStyle, getHintTextStyle, getPromptDimVeilAlpha } from '../main/colorUtils.js';
import {
    A11Y_BUTTON_WIDTH,
    A11Y_BUTTON_HEIGHT,
    A11Y_BUTTON_X_OFFSET,
    A11Y_BUTTON_Y_OFFSET,
    SESSION_BUTTON_WIDTH,
    SESSION_BUTTON_HEIGHT,
    SESSION_BUTTON_X_OFFSET,
    SESSION_BUTTON_Y_OFFSET,
} from '../main/constants.js';
import { _logError, resolveGdmAccessibleUri } from './gdmUtils.js';

export class GdmPromptStyling {
    constructor(gdmManager) {
        this._gdm = gdmManager;
        this.cursorBlinkTimeoutId = 0;
        this.promptColorRequestId = 0;
        this.bottomButtonsColorRequestId = 0;
        this._lastA11yColor = null;
        this._lastSessionColor = null;
        this._lastPromptColor = null;
        this._lastClockAlpha = null;
    }

    teardown() {
        this.stopCursorBlink();
        this.clearCupertinoPromptBackground();
        this.clearBottomButtonsBackground();
    }

    startCursorBlink() {
        this.stopCursorBlink();

        const authPrompt = this._gdm._dialog?._authPrompt;
        if (!authPrompt) return;

        const entry = this.findPromptEntry(authPrompt);
        let cursorBlink = true;
        const currentMetadata = this._gdm._currentWallpaperMetadata;
        if (currentMetadata && currentMetadata.cursorBlink != null) {
            cursorBlink = currentMetadata.cursorBlink;
        } else if (this._gdm._extension) {
            cursorBlink = this._gdm._extension.getSettings().get_boolean('cursor-blink');
        }

        if (entry && entry.clutter_text) {
            entry.clutter_text.cursor_blink = cursorBlink;
            entry.clutter_text.cursor_visible = true;
        }

        if (cursorBlink === false)
            return;

        let visible = true;
        this.cursorBlinkTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            const currentAuthPrompt = this._gdm._dialog?._authPrompt;
            if (!this._gdm._dialog || !currentAuthPrompt || !currentAuthPrompt.visible) {
                this.cursorBlinkTimeoutId = 0;
                return GLib.SOURCE_REMOVE;
            }

            const currentEntry = this.findPromptEntry(currentAuthPrompt);
            if (!currentEntry || !currentEntry.clutter_text) {
                return GLib.SOURCE_CONTINUE;
            }

            if (!currentEntry.clutter_text.has_key_focus()) {
                currentEntry.clutter_text.cursor_visible = false;
                return GLib.SOURCE_CONTINUE;
            }

            visible = !visible;
            currentEntry.clutter_text.cursor_visible = visible;
            return GLib.SOURCE_CONTINUE;
        });
    }

    stopCursorBlink() {
        if (this.cursorBlinkTimeoutId) {
            GLib.source_remove(this.cursorBlinkTimeoutId);
            this.cursorBlinkTimeoutId = 0;
        }
    }

    findPromptEntry(actor) {
        if (!actor)
            return null;

        if (actor.has_style_class_name && actor.has_style_class_name('login-dialog-prompt-entry')) {
            return actor;
        }

        if (!actor.get_children)
            return null;

        for (const child of actor.get_children()) {
            const match = this.findPromptEntry(child);
            if (match)
                return match;
        }

        return null;
    }

    applyPromptEntryBackground(entry, color) {
        if (!entry)
            return;

        if (!color) {
            entry.disconnectObject(this);
            if (entry.clutter_text)
                entry.clutter_text.disconnectObject(this);
            if (global.stage)
                global.stage.disconnectObject(entry);

            const authPrompt = this._gdm._dialog?._authPrompt;
            if (authPrompt)
                authPrompt.disconnectObject(this);

            if (entry._wackOriginalStyle !== undefined) {
                entry.set_style(entry._wackOriginalStyle);
                delete entry._wackOriginalStyle;
            } else {
                entry.set_style(null);
            }
            delete entry._wackColor;
            delete entry._wackPreserveFocus;
            return;
        }

        entry._wackColor = color;

        if (entry._wackOriginalStyle === undefined) {
            entry._wackOriginalStyle = entry.get_style() ?? '';

            entry.connectObject(
                'notify::has-focus', () => this._updatePromptEntryStyle(entry),
                'key-focus-in', () => {
                    entry._wackPreserveFocus = false;
                    this._updatePromptEntryStyle(entry);
                    return Clutter.EVENT_PROPAGATE;
                },
                'key-focus-out', () => {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        if (entry && entry.get_stage && entry.get_stage())
                            this._updatePromptEntryStyle(entry);
                        return GLib.SOURCE_REMOVE;
                    });
                    return Clutter.EVENT_PROPAGATE;
                },
                'destroy', () => {
                    if (global.stage)
                        global.stage.disconnectObject(entry);
                },
                this
            );
            if (entry.clutter_text) {
                entry.clutter_text.connectObject(
                    'notify::has-key-focus', () => this._updatePromptEntryStyle(entry),
                    'key-focus-in', () => {
                        entry._wackPreserveFocus = false;
                        this._updatePromptEntryStyle(entry);
                        return Clutter.EVENT_PROPAGATE;
                    },
                    'key-focus-out', () => {
                        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                            if (entry && entry.get_stage && entry.get_stage())
                                this._updatePromptEntryStyle(entry);
                            return GLib.SOURCE_REMOVE;
                        });
                        return Clutter.EVENT_PROPAGATE;
                    },
                    'activate', () => {
                        entry._wackPreserveFocus = true;
                        this._updatePromptEntryStyle(entry);
                    },
                    this
                );
            }

            if (global.stage) {
                global.stage.connectObject(
                    'notify::key-focus', () => {
                        if (!entry || !entry.get_stage || !entry.get_stage())
                            return;
                        this._updatePromptEntryStyle(entry);
                    },
                    entry
                );
            }

            const authPrompt = this._gdm._dialog?._authPrompt;
            if (authPrompt) {
                authPrompt.connectObject(
                    'reset', () => {
                        entry._wackPreserveFocus = false;
                        this._updatePromptEntryStyle(entry);
                    },
                    'failed', () => {
                        entry._wackPreserveFocus = false;
                        this._updatePromptEntryStyle(entry);
                    },
                    'cancelled', () => {
                        entry._wackPreserveFocus = false;
                        this._updatePromptEntryStyle(entry);
                    },
                    this
                );
            }
        }

        this._updatePromptEntryStyle(entry);
    }

    _updatePromptEntryStyle(entry) {
        if (!entry || !entry.get_stage || !entry.get_stage())
            return;

        const color = entry._wackColor;
        if (!color)
            return;

        const keyFocus = global.stage ? global.stage.key_focus : null;
        const textActor = entry.clutter_text ?? null;
        const hasDirectFocus = entry.has_focus ||
            keyFocus === entry ||
            (textActor ? (keyFocus === textActor || textActor.has_key_focus()) : false);

        const isFocused = hasDirectFocus || (entry._wackPreserveFocus === true);

        const visualState = color.visualState ?? color;
        const veilAlpha = getPromptDimVeilAlpha(visualState);

        const defaultVibrancy = this._gdm._extension ? this._gdm._extension.getSettings().get_string('prompt-vibrancy') : 'tonal';
        const vibrancyMode = color.vibrancyMode ?? defaultVibrancy;
        const isSolid = (vibrancyMode === 'tonal' || vibrancyMode === 'less');

        let shadowStyle = '';
        let bgStyle;

        if (!isSolid && color.imagePath) {
            const imageUri = color.imagePath.startsWith('file://') ? color.imagePath : `file://${color.imagePath}`;
            if (isFocused) {
                if (color.shadowAlpha !== undefined)
                    shadowStyle = ` box-shadow: 0 2px 24px rgba(0, 0, 0, ${color.shadowAlpha.toFixed(3)}) !important;`;
            } else {
                const sAlpha = color.shadowAlpha !== undefined ? (color.shadowAlpha * (1.0 - veilAlpha)).toFixed(3) : '0';
                shadowStyle = ` box-shadow: 0 2px 24px rgba(0, 0, 0, ${sAlpha}), inset 0 0 0 999px rgba(0, 0, 0, ${veilAlpha.toFixed(3)}) !important;`;
            }
            bgStyle = ` background-color: transparent !important; background-gradient-direction: none !important; background-image: url("${imageUri}") !important; background-size: cover !important; background-position: center !important; background-repeat: no-repeat !important; border: none !important;`;
        } else {
            const dimFactor = isFocused ? 1.0 : (1.0 - veilAlpha);

            if (color.shadowAlpha !== undefined) {
                const sAlpha = isFocused ? color.shadowAlpha : color.shadowAlpha * dimFactor;
                shadowStyle = ` box-shadow: 0 2px 24px rgba(0, 0, 0, ${sAlpha.toFixed(3)}) !important;`;
            }

            if (color.start && color.end && color.direction && color.direction !== 'none') {
                const sR = Math.round(color.start.r * dimFactor);
                const sG = Math.round(color.start.g * dimFactor);
                const sB = Math.round(color.start.b * dimFactor);
                const eR = Math.round(color.end.r * dimFactor);
                const eG = Math.round(color.end.g * dimFactor);
                const eB = Math.round(color.end.b * dimFactor);
                bgStyle = ` background-color: transparent !important; background-gradient-direction: ${color.direction} !important; background-gradient-start: rgb(${sR}, ${sG}, ${sB}) !important; background-gradient-end: rgb(${eR}, ${eG}, ${eB}) !important; background-image: none !important; border: none !important;`;
            } else {
                const curR = Math.round(color.r * dimFactor);
                const curG = Math.round(color.g * dimFactor);
                const curB = Math.round(color.b * dimFactor);
                bgStyle = ` background-image: none !important; background-gradient-direction: none !important; background-color: rgb(${curR}, ${curG}, ${curB}) !important; border: none !important;`;
            }
        }

        entry.set_style(`${entry._wackOriginalStyle}${bgStyle}${shadowStyle}`);

        this._lastPromptColor = color;
        this.updatePromptMessageStyle(color);
    }

    updatePromptMessageStyle(color = null, alpha = null) {
        const authPrompt = this._gdm._dialog?._authPrompt;
        if (!authPrompt || !authPrompt.has_style_class_name('wack-cupertino-prompt'))
            return;

        if (color)
            this._lastPromptColor = color;
        if (alpha != null)
            this._lastClockAlpha = alpha;

        const effectiveColor = color
            ?? this._lastPromptColor
            ?? this._gdm._currentWallpaperMetadata?.promptColor
            ?? this._gdm._avatarManager?._lastAvatarColor
            ?? null;

        const effectiveAlpha = alpha
            ?? this._lastClockAlpha
            ?? this._gdm._currentWallpaperMetadata?.clockAlpha
            ?? this._gdm._lastClockAlpha
            ?? null;

        if (effectiveColor || effectiveAlpha != null) {
            const msgStyle = getHintTextStyle(effectiveColor, effectiveAlpha);
            if (authPrompt._message) {
                authPrompt._message.set_style(msgStyle);
                authPrompt._message.add_style_class_name('wack-cupertino-message');
            }
            if (authPrompt._capsLockWarningLabel)
                authPrompt._capsLockWarningLabel.set_style(msgStyle);
        }
    }

    _findMenuForButton(button) {
        if (!button)
            return null;
        if (button._menu)
            return button._menu;
        if (button.menu)
            return button.menu;
        if (button._authMenuButton?._menu)
            return button._authMenuButton._menu;
        if (button._authMenuButton?.menu)
            return button._authMenuButton.menu;
        if (button._sessionMenuButton?._menu)
            return button._sessionMenuButton._menu;
        if (button._sessionMenuButton?.menu)
            return button._sessionMenuButton.menu;
        const parent = button.get_parent ? button.get_parent() : null;
        if (parent) {
            if (parent._menu)
                return parent._menu;
            if (parent.menu)
                return parent.menu;
            if (parent._authMenuButton?._menu)
                return parent._authMenuButton._menu;
            if (parent._sessionMenuButton?._menu)
                return parent._sessionMenuButton._menu;
        }
        const dialog = this._gdm?._dialog;
        if (dialog) {
            if (dialog._authMenuButton?._menu)
                return dialog._authMenuButton._menu;
            if (dialog._sessionMenuButton?._menu)
                return dialog._sessionMenuButton._menu;
            if (dialog._sessionMenuButton?.menu)
                return dialog._sessionMenuButton.menu;
        }
        return null;
    }

    _setupChromeButton(button, color, buttonType = 'generic') {
        if (!button)
            return;

        if (!color) {
            button.disconnectObject(this);
            const menu = this._findMenuForButton(button);
            if (menu)
                menu.disconnectObject(button);
            if (button._wackOriginalStyle !== undefined) {
                button.set_style(button._wackOriginalStyle);
                delete button._wackOriginalStyle;
            } else {
                button.set_style(null);
            }
            delete button._wackColor;
            delete button._wackMousePressed;
            delete button._wackKeyPressed;
            delete button._wackButtonType;
            delete button._wackMenuConnected;
            delete button._wackOpenedViaKey;
            return;
        }

        button._wackColor = color;
        button._wackButtonType = buttonType;

        if (button._wackOriginalStyle === undefined) {
            button._wackOriginalStyle = button.get_style() ?? '';

            button.connectObject(
                'notify::hover', () => {
                    if (!button.hover)
                        button._wackMousePressed = false;
                    this._updateChromeButtonStyle(button, button._wackButtonType);
                },
                'notify::has-focus', () => this._updateChromeButtonStyle(button, button._wackButtonType),
                'notify::pseudo-class', () => this._updateChromeButtonStyle(button, button._wackButtonType),
                'notify::checked', () => this._updateChromeButtonStyle(button, button._wackButtonType),
                'clicked', () => {
                    button._wackMousePressed = false;
                    button._wackKeyPressed = false;
                    this._updateChromeButtonStyle(button, button._wackButtonType);
                },
                'button-press-event', () => {
                    button._wackMousePressed = true;
                    button._wackOpenedViaKey = false;
                    this._updateChromeButtonStyle(button, button._wackButtonType);
                    return Clutter.EVENT_PROPAGATE;
                },
                'button-release-event', () => {
                    button._wackMousePressed = false;
                    this._updateChromeButtonStyle(button, button._wackButtonType);
                    return Clutter.EVENT_PROPAGATE;
                },
                'leave-event', () => {
                    button._wackMousePressed = false;
                    this._updateChromeButtonStyle(button, button._wackButtonType);
                    return Clutter.EVENT_PROPAGATE;
                },
                'key-press-event', (actor, event) => {
                    const keyval = event.get_key_symbol();
                    if (keyval === Clutter.KEY_space || keyval === Clutter.KEY_Return || keyval === Clutter.KEY_KP_Enter || keyval === Clutter.KEY_ISO_Enter) {
                        button._wackKeyPressed = true;
                        button._wackOpenedViaKey = true;
                        this._updateChromeButtonStyle(button, button._wackButtonType);
                    }
                    return Clutter.EVENT_PROPAGATE;
                },
                'key-release-event', (actor, event) => {
                    button._wackKeyPressed = false;
                    this._updateChromeButtonStyle(button, button._wackButtonType);
                    return Clutter.EVENT_PROPAGATE;
                },
                'key-focus-out', () => {
                    button._wackKeyPressed = false;
                    button._wackMousePressed = false;
                    this._updateChromeButtonStyle(button, button._wackButtonType);
                },
                this
            );
        }

        const menu = this._findMenuForButton(button);
        if (menu && !button._wackMenuConnected) {
            button._wackMenuConnected = true;
            menu.connectObject(
                'open-state-changed', (m, isOpen) => {
                    button._wackMousePressed = false;
                    button._wackKeyPressed = false;
                    if (!isOpen) {
                        button._wackOpenedViaKey = false;
                    }
                    this._updateChromeButtonStyle(button, button._wackButtonType);
                },
                button
            );
        }

        this._updateChromeButtonStyle(button, buttonType);
    }

    _updateChromeButtonStyle(button, buttonType = 'generic') {
        const color = button._wackColor;
        if (!color)
            return;

        const menu = this._findMenuForButton(button);
        if (menu && !button._wackMenuConnected) {
            button._wackMenuConnected = true;
            menu.connectObject(
                'open-state-changed', (m, isOpen) => {
                    button._wackMousePressed = false;
                    button._wackKeyPressed = false;
                    if (!isOpen) {
                        button._wackOpenedViaKey = false;
                    }
                    this._updateChromeButtonStyle(button, button._wackButtonType);
                },
                button
            );
        }

        const isMenuOpen = menu ? menu.isOpen : false;

        const isPressed = button._wackMousePressed ||
            button._wackKeyPressed ||
            isMenuOpen ||
            button.has_style_pseudo_class('active') ||
            button.has_style_pseudo_class('checked') ||
            button.checked;
        const isHovered = button.hover && !isPressed;
        const isFocused = button.has_focus || (isMenuOpen && button._wackOpenedViaKey);

        const colorObj = buttonType === 'cancel'
            ? (color.cancelColor ?? (color.r !== undefined ? color : null))
            : buttonType === 'a11y'
                ? (color.a11yColor ?? (color.r !== undefined ? color : null))
                : buttonType === 'session'
                    ? (color.sessionColor ?? (color.r !== undefined ? color : null))
                    : color;

        if (!colorObj || colorObj.r == null || colorObj.g == null || colorObj.b == null)
            return;

        const visualState = colorObj.visualState ?? color.visualState ?? colorObj;
        const hoverAlpha = getChromeAlpha(visualState, 'hover');
        const activeAlpha = getChromeAlpha(visualState, 'active');
        const focusAlpha = getChromeAlpha(visualState, 'focus');

        let curR = colorObj.r;
        let curG = colorObj.g;
        let curB = colorObj.b;

        if (isPressed) {
            const invA = 1 - activeAlpha;
            curR = Math.min(255, Math.max(0, Math.round(curR * invA + 255 * activeAlpha)));
            curG = Math.min(255, Math.max(0, Math.round(curG * invA + 255 * activeAlpha)));
            curB = Math.min(255, Math.max(0, Math.round(curB * invA + 255 * activeAlpha)));
        } else if (isHovered) {
            const invA = 1 - hoverAlpha;
            curR = Math.min(255, Math.max(0, Math.round(curR * invA + 255 * hoverAlpha)));
            curG = Math.min(255, Math.max(0, Math.round(curG * invA + 255 * hoverAlpha)));
            curB = Math.min(255, Math.max(0, Math.round(curB * invA + 255 * hoverAlpha)));
        }

        let overlayStyle = '';
        if (isHovered) {
            overlayStyle += ` color: #ffffff !important;`;
        }
        if (isFocused) {
            overlayStyle += ` border: 1px solid rgba(255, 255, 255, 0.8) !important;`;
        }

        let shadowStyle = '';
        if (buttonType === 'cancel') {
            const rawShadow = colorObj.shadowAlpha ?? color.shadowAlpha ?? visualState.shadowAlpha;
            if (rawShadow !== undefined && rawShadow !== null && rawShadow > 0) {
                const cancelShadowAlpha = rawShadow * 0.75;
                shadowStyle = ` box-shadow: 0 2px 24px rgba(0, 0, 0, ${cancelShadowAlpha.toFixed(3)}) !important;`;
            }
        }

        const bgStyle = ` background-image: none !important; background-gradient-direction: none !important; background-color: rgb(${curR}, ${curG}, ${curB}) !important;${overlayStyle}${shadowStyle}`;

        button.set_style(`${button._wackOriginalStyle}${bgStyle}`);
    }

    applyCancelButtonBackground(button, color) {
        this._setupChromeButton(button, color, 'cancel');
    }

    updateCancelButtonStyle(button) {
        this._updateChromeButtonStyle(button, 'cancel');
    }

    applyA11yButtonBackground(button, color) {
        this._setupChromeButton(button, color, 'a11y');
    }

    applySessionButtonBackground(button, color) {
        this._setupChromeButton(button, color, 'session');
    }

    clearCupertinoPromptBackground() {
        const authPrompt = this._gdm._dialog?._authPrompt;
        const entry = this.findPromptEntry(authPrompt);
        if (entry)
            this.applyPromptEntryBackground(entry, null);

        const cancelButton = authPrompt?.cancelButton;
        if (cancelButton)
            this.applyCancelButtonBackground(cancelButton, null);

        if (authPrompt?._message)
            authPrompt._message.set_style(null);
        if (authPrompt?._capsLockWarningLabel)
            authPrompt._capsLockWarningLabel.set_style(null);
    }

    clearBottomButtonsBackground() {
        const dialog = this._gdm._dialog;
        const a11yButton = dialog?._a11yMenuButton
            ?? dialog?._bottomButtonGroup?._a11yMenuButton
            ?? dialog?._bottomButtonGroup?.get_children().find(c => c.has_style_class_name('a11y-button'));
        if (a11yButton)
            this.applyA11yButtonBackground(a11yButton, null);

        const sessionButton = dialog?._authMenuButton
            ?? dialog?._sessionMenuButton?._button
            ?? dialog?._sessionMenuButton?.get_child()
            ?? dialog?._sessionMenuButton
            ?? dialog?._bottomButtonGroup?._authMenuButton
            ?? dialog?._bottomButtonGroup?._sessionMenuButton?._button
            ?? dialog?._bottomButtonGroup?._sessionMenuButton
            ?? dialog?._bottomButtonGroup?.get_children().find(c => c.has_style_class_name('login-dialog-auth-menu-button') || c.has_style_class_name('login-dialog-session-list-button'));
        if (sessionButton)
            this.applySessionButtonBackground(sessionButton, null);
    }

    async updateCupertinoPromptBackground(metadata = null) {
        const authPrompt = this._gdm._dialog?._authPrompt;
        if (!authPrompt)
            return;

        const entry = this.findPromptEntry(authPrompt);
        if (!entry)
            return;

        if (!authPrompt.has_style_class_name('wack-cupertino-prompt')) {
            this.clearCupertinoPromptBackground();
            return;
        }

        const effectiveMetadata = metadata ?? this._gdm._currentWallpaperMetadata;

        let wellH = 0;
        if (this._gdm._cupertinoRestPrompt?._userWell) {
            const [, , , hSize] = this._gdm._cupertinoRestPrompt._userWell.get_preferred_size();
            wellH = hSize > 0 ? hSize : 0;
        }

        let yCenterFraction = null;
        let promptBounds = null;
        if (entry) {
            const [xTrans, yTrans] = entry.get_transformed_position();
            const wTrans = entry.get_width() || 0;
            const hTrans = entry.get_height() || 0;
            const monitor = Main.layoutManager?.primaryMonitor;
            const monitorX = monitor ? monitor.x : 0;
            const monitorY = monitor ? monitor.y : 0;
            const monitorHeight = monitor ? monitor.height : 1080;
            const monitorWidth = monitor ? monitor.width : 1920;
            if (yTrans > 0 && monitorHeight > 0)
                yCenterFraction = (yTrans + hTrans / 2 - monitorY) / monitorHeight;
            if (wTrans > 0 && hTrans > 0 && monitorWidth > 0 && monitorHeight > 0 && xTrans >= monitorX && yTrans >= monitorY) {
                promptBounds = {
                    x1: Math.max(0, Math.min(1, (xTrans - monitorX) / monitorWidth)),
                    x2: Math.max(0, Math.min(1, (xTrans + wTrans - monitorX) / monitorWidth)),
                    y1: Math.max(0, Math.min(1, (yTrans - monitorY) / monitorHeight)),
                    y2: Math.max(0, Math.min(1, (yTrans + hTrans - monitorY) / monitorHeight)),
                };
            }
        }

        let cancelBounds = null;
        const cancelButton = authPrompt?.cancelButton;
        if (cancelButton && cancelButton.get_stage()) {
            const [cxTrans, cyTrans] = cancelButton.get_transformed_position();
            const cwTrans = cancelButton.get_width() || 34;
            const chTrans = cancelButton.get_height() || 34;
            const monitor = Main.layoutManager?.primaryMonitor;
            const monitorX = monitor ? monitor.x : 0;
            const monitorY = monitor ? monitor.y : 0;
            const monitorHeight = monitor ? monitor.height : 1080;
            const monitorWidth = monitor ? monitor.width : 1920;
            if (cwTrans > 0 && chTrans > 0 && monitorWidth > 0 && monitorHeight > 0 && cxTrans >= monitorX && cyTrans >= monitorY) {
                cancelBounds = {
                    x1: Math.max(0, Math.min(1, (cxTrans - monitorX) / monitorWidth)),
                    x2: Math.max(0, Math.min(1, (cxTrans + cwTrans - monitorX) / monitorWidth)),
                    y1: Math.max(0, Math.min(1, (cyTrans - monitorY) / monitorHeight)),
                    y2: Math.max(0, Math.min(1, (cyTrans + chTrans - monitorY) / monitorHeight)),
                };
            }
        }

        let avatarBounds = null;
        const avatarButton = this._gdm._cupertinoRestPrompt?._userWell?.get_child()?._avatarButton
            ?? authPrompt?._userWell?.get_child()?._avatarButton;
        if (avatarButton && avatarButton.get_stage()) {
            const [axTrans, ayTrans] = avatarButton.get_transformed_position();
            const awTrans = avatarButton.get_width() || 56;
            const ahTrans = avatarButton.get_height() || 56;
            const monitor = Main.layoutManager?.primaryMonitor;
            const monitorX = monitor ? monitor.x : 0;
            const monitorY = monitor ? monitor.y : 0;
            const monitorHeight = monitor ? monitor.height : 1080;
            const monitorWidth = monitor ? monitor.width : 1920;
            if (awTrans > 0 && ahTrans > 0 && monitorWidth > 0 && monitorHeight > 0 && axTrans >= monitorX && ayTrans >= monitorY) {
                avatarBounds = {
                    x1: Math.max(0, Math.min(1, (axTrans - monitorX) / monitorWidth)),
                    x2: Math.max(0, Math.min(1, (axTrans + awTrans - monitorX) / monitorWidth)),
                    y1: Math.max(0, Math.min(1, (ayTrans - monitorY) / monitorHeight)),
                    y2: Math.max(0, Math.min(1, (ayTrans + ahTrans - monitorY) / monitorHeight)),
                };
            }
        }

        let a11yBounds = null;
        const currentDialog = this._gdm._dialog;
        const a11yButton = currentDialog?._a11yMenuButton
            ?? currentDialog?._bottomButtonGroup?._a11yMenuButton
            ?? currentDialog?._bottomButtonGroup?.get_children().find(c => c.has_style_class_name('a11y-button'));
        if (a11yButton && a11yButton.get_stage()) {
            const [axTrans, ayTrans] = a11yButton.get_transformed_position();
            const awTrans = a11yButton.get_width() || A11Y_BUTTON_WIDTH;
            const ahTrans = a11yButton.get_height() || A11Y_BUTTON_HEIGHT;
            const monitor = Main.layoutManager?.primaryMonitor;
            const monitorX = monitor ? monitor.x : 0;
            const monitorY = monitor ? monitor.y : 0;
            const monitorHeight = monitor ? monitor.height : 1080;
            const monitorWidth = monitor ? monitor.width : 1920;
            if (awTrans > 0 && ahTrans > 0 && monitorWidth > 0 && monitorHeight > 0 && axTrans >= monitorX && ayTrans >= monitorY) {
                const effectiveX = axTrans + A11Y_BUTTON_X_OFFSET;
                const effectiveY = ayTrans + A11Y_BUTTON_Y_OFFSET;
                a11yBounds = {
                    x1: Math.max(0, Math.min(1, (effectiveX - monitorX) / monitorWidth)),
                    x2: Math.max(0, Math.min(1, (effectiveX + awTrans - monitorX) / monitorWidth)),
                    y1: Math.max(0, Math.min(1, (effectiveY - monitorY) / monitorHeight)),
                    y2: Math.max(0, Math.min(1, (effectiveY + ahTrans - monitorY) / monitorHeight)),
                };
            }
        }

        let sessionBounds = null;
        const sessionButton = currentDialog?._authMenuButton
            ?? currentDialog?._sessionMenuButton?._button
            ?? currentDialog?._sessionMenuButton?.get_child()
            ?? currentDialog?._sessionMenuButton
            ?? currentDialog?._bottomButtonGroup?._authMenuButton
            ?? currentDialog?._bottomButtonGroup?._sessionMenuButton?._button
            ?? currentDialog?._bottomButtonGroup?._sessionMenuButton
            ?? currentDialog?._bottomButtonGroup?.get_children().find(c => c.has_style_class_name('login-dialog-auth-menu-button') || c.has_style_class_name('login-dialog-session-list-button'));
        if (sessionButton && sessionButton.get_stage()) {
            const [sxTrans, syTrans] = sessionButton.get_transformed_position();
            const swTrans = sessionButton.get_width() || SESSION_BUTTON_WIDTH;
            const shTrans = sessionButton.get_height() || SESSION_BUTTON_HEIGHT;
            const monitor = Main.layoutManager?.primaryMonitor;
            const monitorX = monitor ? monitor.x : 0;
            const monitorY = monitor ? monitor.y : 0;
            const monitorHeight = monitor ? monitor.height : 1080;
            const monitorWidth = monitor ? monitor.width : 1920;
            if (swTrans > 0 && shTrans > 0 && monitorWidth > 0 && monitorHeight > 0 && sxTrans >= monitorX && syTrans >= monitorY) {
                const effectiveX = sxTrans + SESSION_BUTTON_X_OFFSET;
                const effectiveY = syTrans + SESSION_BUTTON_Y_OFFSET;
                sessionBounds = {
                    x1: Math.max(0, Math.min(1, (effectiveX - monitorX) / monitorWidth)),
                    x2: Math.max(0, Math.min(1, (effectiveX + swTrans - monitorX) / monitorWidth)),
                    y1: Math.max(0, Math.min(1, (effectiveY - monitorY) / monitorHeight)),
                    y2: Math.max(0, Math.min(1, (effectiveY + shTrans - monitorY) / monitorHeight)),
                };
            }
        }

        let wallpaperParams = null;
        if (effectiveMetadata) {
            const promptColor = effectiveMetadata.promptColor;
            const hasValidPromptImage = promptColor?.imagePath &&
                Gio.File.new_for_path(promptColor.imagePath).query_exists(null);

            let avatarColor = promptColor?.avatarColor;
            if (!avatarColor && promptColor && promptColor.r != null) {
                // Derive avatar color directly from the already-blended prompt color.
                // Do NOT call getPromptBlendOverlay() here — that would make an
                // independent useInverse decision on the already-blended (potentially
                // dark) prompt color and invert the direction. The prompt color's
                // r/g/b IS the correct final pre-blended result from the unified
                // promptVisualState, so use it directly as the avatar background.
                avatarColor = {
                    r: promptColor.r,
                    g: promptColor.g,
                    b: promptColor.b,
                    rgba: promptColor.rgba ?? `rgba(${promptColor.r}, ${promptColor.g}, ${promptColor.b}, 1.0)`,
                };
            }

            const a11yColorToApply = promptColor?.a11yColor ?? this._lastA11yColor;
            const sessionColorToApply = promptColor?.sessionColor ?? this._lastSessionColor;

            if (promptColor?.a11yColor)
                this._lastA11yColor = promptColor.a11yColor;
            if (promptColor?.sessionColor)
                this._lastSessionColor = promptColor.sessionColor;

            const defaultVibrancy = this._gdm._extension ? this._gdm._extension.getSettings().get_string('prompt-vibrancy') : 'tonal';
            const vibrancyMode = effectiveMetadata?.promptVibrancyMode ?? defaultVibrancy;
            const isSolid = (vibrancyMode === 'tonal' || vibrancyMode === 'less');

            if (promptColor &&
                promptColor.r != null &&
                promptColor.g != null &&
                promptColor.b != null &&
                (isSolid || hasValidPromptImage)) {
                this.applyPromptEntryBackground(entry, promptColor);
                if (authPrompt.cancelButton)
                    this.applyCancelButtonBackground(authPrompt.cancelButton, promptColor);
                if (this._gdm?._avatarManager && avatarColor)
                    this._gdm._avatarManager.updateAvatarVibrancy(avatarColor);
                if (a11yButton && a11yColorToApply)
                    this.applyA11yButtonBackground(a11yButton, a11yColorToApply);
                if (sessionButton && sessionColorToApply)
                    this.applySessionButtonBackground(sessionButton, sessionColorToApply);

                if (isSolid || hasValidPromptImage)
                    return;
            }

            wallpaperParams = {
                uri: resolveGdmAccessibleUri(effectiveMetadata),
                isColor: effectiveMetadata.is_color,
                primaryColor: effectiveMetadata.primary_color,
                secondaryColor: effectiveMetadata.secondary_color,
                shadingType: effectiveMetadata.shading_type,
                wellH: wellH,
                yCenterFraction: yCenterFraction,
                promptBounds: promptBounds,
                cancelBounds: cancelBounds,
                avatarBounds: avatarBounds,
                a11yBounds: a11yBounds,
                sessionBounds: sessionBounds,
                vibrancyMode: vibrancyMode,
            };
        } else {
            const bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
            const uri = bgSettings.get_string('picture-uri');
            const style = bgSettings.get_enum('picture-options');
            const primaryColor = bgSettings.get_string('primary-color');
            const secondaryColor = bgSettings.get_string('secondary-color');
            const shadingType = bgSettings.get_enum('color-shading-type');
            const isColor = (style === 0);

            wallpaperParams = {
                uri,
                isColor,
                primaryColor,
                secondaryColor,
                shadingType,
                wellH: wellH,
                yCenterFraction: yCenterFraction,
                promptBounds: promptBounds,
                cancelBounds: cancelBounds,
                avatarBounds: avatarBounds,
                a11yBounds: a11yBounds,
                sessionBounds: sessionBounds,
            };
        }

        if (!wallpaperParams)
            return;

        const requestId = ++this.promptColorRequestId;
        const color = await getWallpaperPromptColor(wallpaperParams);

        if (requestId !== this.promptColorRequestId)
            return;

        if (color && effectiveMetadata) {
            effectiveMetadata.promptColor = color;
            if (this._gdm._currentWallpaperMetadata)
                this._gdm._currentWallpaperMetadata.promptColor = color;

            if (effectiveMetadata.username === 'gdm' || !effectiveMetadata.username) {
                if (this._gdm._wallpaperManager)
                    this._gdm._wallpaperManager.saveGdmWallpaperMetadata(effectiveMetadata);
            }
        }

        const currentPrompt = this._gdm._dialog?._authPrompt;
        const currentEntry = this.findPromptEntry(currentPrompt);
        if (!currentPrompt || !currentEntry || !currentPrompt.has_style_class_name('wack-cupertino-prompt'))
            return;

        if (!color) {
            this.clearCupertinoPromptBackground();
            return;
        }

        this.applyPromptEntryBackground(currentEntry, color);
        if (currentPrompt.cancelButton)
            this.applyCancelButtonBackground(currentPrompt.cancelButton, color);

        let finalAvatarColor = color?.avatarColor;
        if (!finalAvatarColor && color && color.r != null) {
            // Derive avatar color directly from the already-blended prompt color.
            // Do NOT call getPromptBlendOverlay() here — that would make an
            // independent useInverse decision on the already-blended (potentially
            // dark) prompt color and invert the direction. The prompt color's
            // r/g/b IS the correct final pre-blended result from the unified
            // promptVisualState, so use it directly as the avatar background.
            finalAvatarColor = {
                r: color.r,
                g: color.g,
                b: color.b,
                rgba: color.rgba ?? `rgba(${color.r}, ${color.g}, ${color.b}, 1.0)`,
            };
        }
        if (this._gdm?._avatarManager && finalAvatarColor)
            this._gdm._avatarManager.updateAvatarVibrancy(finalAvatarColor);

        if (color.a11yColor)
            this._lastA11yColor = color.a11yColor;
        if (color.sessionColor)
            this._lastSessionColor = color.sessionColor;

        if (a11yButton && color.a11yColor)
            this.applyA11yButtonBackground(a11yButton, color.a11yColor);
        if (sessionButton && color.sessionColor)
            this.applySessionButtonBackground(sessionButton, color.sessionColor);
    }

    /**
     * Style the a11y and session bottom buttons from the wallpaper, with no
     * dependency on authPrompt or the wack-cupertino-prompt class.  Called
     * immediately on GDM cold boot (applyWallpaper) so the buttons are
     * vibrancy-coloured before any user is selected.
     */
    async updateBottomButtonsBackground(metadata = null) {
        const effectiveMetadata = metadata ?? this._gdm._currentWallpaperMetadata;
        const currentDialog = this._gdm._dialog;

        const a11yButton = currentDialog?._a11yMenuButton
            ?? currentDialog?._bottomButtonGroup?._a11yMenuButton
            ?? currentDialog?._bottomButtonGroup?.get_children().find(c => c.has_style_class_name('a11y-button'));

        const sessionButton = currentDialog?._authMenuButton
            ?? currentDialog?._sessionMenuButton?._button
            ?? currentDialog?._sessionMenuButton?.get_child()
            ?? currentDialog?._sessionMenuButton
            ?? currentDialog?._bottomButtonGroup?._authMenuButton
            ?? currentDialog?._bottomButtonGroup?._sessionMenuButton?._button
            ?? currentDialog?._bottomButtonGroup?._sessionMenuButton
            ?? currentDialog?._bottomButtonGroup?.get_children().find(c => c.has_style_class_name('login-dialog-auth-menu-button') || c.has_style_class_name('login-dialog-session-list-button'));

        if (!a11yButton && !sessionButton)
            return;

        // Fast path: use metadata promptColor first, or fallback to live cached color.
        const promptColor = effectiveMetadata?.promptColor;

        if (promptColor) {
            if (promptColor.a11yColor)
                this._lastA11yColor = promptColor.a11yColor;
            if (promptColor.sessionColor)
                this._lastSessionColor = promptColor.sessionColor;

            // Push avatar color to the user list tiles immediately.
            const cachedAvatarColor = promptColor.avatarColor ?? (promptColor.r != null ? {
                r: promptColor.r,
                g: promptColor.g,
                b: promptColor.b,
                rgba: promptColor.rgba ?? `rgba(${promptColor.r}, ${promptColor.g}, ${promptColor.b}, 1.0)`,
            } : null);
            if (this._gdm?._avatarManager && cachedAvatarColor)
                this._gdm._avatarManager.updateAvatarVibrancy(cachedAvatarColor);
        }

        const a11yColorToApply = promptColor?.a11yColor ?? this._lastA11yColor;
        const sessionColorToApply = promptColor?.sessionColor ?? this._lastSessionColor;

        if (a11yButton && a11yColorToApply)
            this.applyA11yButtonBackground(a11yButton, a11yColorToApply);
        if (sessionButton && sessionColorToApply)
            this.applySessionButtonBackground(sessionButton, sessionColorToApply);

        if (promptColor?.a11yColor && promptColor?.sessionColor)
            return;

        // Build minimal bounds for the buttons we found — prompt/cancel/avatar
        // are left null so alphaManager only samples what it needs.
        const monitor = Main.layoutManager?.primaryMonitor;
        const monitorX = monitor ? monitor.x : 0;
        const monitorY = monitor ? monitor.y : 0;
        const monitorWidth = monitor ? monitor.width : 1920;
        const monitorHeight = monitor ? monitor.height : 1080;

        let a11yBounds = null;
        if (a11yButton && a11yButton.get_stage()) {
            const [ax, ay] = a11yButton.get_transformed_position();
            const aw = a11yButton.get_width() || A11Y_BUTTON_WIDTH;
            const ah = a11yButton.get_height() || A11Y_BUTTON_HEIGHT;
            if (aw > 0 && ah > 0 && monitorWidth > 0 && monitorHeight > 0 && ax >= monitorX && ay >= monitorY) {
                const ex = ax + A11Y_BUTTON_X_OFFSET;
                const ey = ay + A11Y_BUTTON_Y_OFFSET;
                a11yBounds = {
                    x1: Math.max(0, Math.min(1, (ex - monitorX) / monitorWidth)),
                    x2: Math.max(0, Math.min(1, (ex + aw - monitorX) / monitorWidth)),
                    y1: Math.max(0, Math.min(1, (ey - monitorY) / monitorHeight)),
                    y2: Math.max(0, Math.min(1, (ey + ah - monitorY) / monitorHeight)),
                };
            }
        }

        let sessionBounds = null;
        if (sessionButton && sessionButton.get_stage()) {
            const [sx, sy] = sessionButton.get_transformed_position();
            const sw = sessionButton.get_width() || SESSION_BUTTON_WIDTH;
            const sh = sessionButton.get_height() || SESSION_BUTTON_HEIGHT;
            if (sw > 0 && sh > 0 && monitorWidth > 0 && monitorHeight > 0 && sx >= monitorX && sy >= monitorY) {
                const ex = sx + SESSION_BUTTON_X_OFFSET;
                const ey = sy + SESSION_BUTTON_Y_OFFSET;
                sessionBounds = {
                    x1: Math.max(0, Math.min(1, (ex - monitorX) / monitorWidth)),
                    x2: Math.max(0, Math.min(1, (ex + sw - monitorX) / monitorWidth)),
                    y1: Math.max(0, Math.min(1, (ey - monitorY) / monitorHeight)),
                    y2: Math.max(0, Math.min(1, (ey + sh - monitorY) / monitorHeight)),
                };
            }
        }

        let wallpaperParams;
        if (effectiveMetadata) {
            wallpaperParams = {
                uri: resolveGdmAccessibleUri(effectiveMetadata),
                isColor: effectiveMetadata.is_color,
                primaryColor: effectiveMetadata.primary_color,
                secondaryColor: effectiveMetadata.secondary_color,
                shadingType: effectiveMetadata.shading_type,
                wellH: 0,
                yCenterFraction: null,
                promptBounds: null,
                cancelBounds: null,
                avatarBounds: null,
                a11yBounds,
                sessionBounds,
            };
        } else {
            const bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
            const uri = bgSettings.get_string('picture-uri');
            const style = bgSettings.get_enum('picture-options');
            wallpaperParams = {
                uri,
                isColor: (style === 0),
                primaryColor: bgSettings.get_string('primary-color'),
                secondaryColor: bgSettings.get_string('secondary-color'),
                shadingType: bgSettings.get_enum('color-shading-type'),
                wellH: 0,
                yCenterFraction: null,
                promptBounds: null,
                cancelBounds: null,
                avatarBounds: null,
                a11yBounds,
                sessionBounds,
            };
        }

        const requestId = ++this.bottomButtonsColorRequestId;
        const color = await getWallpaperPromptColor(wallpaperParams);

        if (requestId !== this.bottomButtonsColorRequestId)
            return;
        if (!color)
            return;

        if (color.a11yColor)
            this._lastA11yColor = color.a11yColor;
        if (color.sessionColor)
            this._lastSessionColor = color.sessionColor;

        // Re-resolve buttons after the await — the dialog may have been replaced.
        const dlg = this._gdm._dialog;
        const freshA11y = dlg?._a11yMenuButton
            ?? dlg?._bottomButtonGroup?._a11yMenuButton
            ?? dlg?._bottomButtonGroup?.get_children().find(c => c.has_style_class_name('a11y-button'));
        const freshSession = dlg?._authMenuButton
            ?? dlg?._sessionMenuButton?._button
            ?? dlg?._sessionMenuButton?.get_child()
            ?? dlg?._sessionMenuButton
            ?? dlg?._bottomButtonGroup?._authMenuButton
            ?? dlg?._bottomButtonGroup?._sessionMenuButton?._button
            ?? dlg?._bottomButtonGroup?._sessionMenuButton
            ?? dlg?._bottomButtonGroup?.get_children().find(c => c.has_style_class_name('login-dialog-auth-menu-button') || c.has_style_class_name('login-dialog-session-list-button'));

        if (freshA11y && color.a11yColor) this.applyA11yButtonBackground(freshA11y, color.a11yColor);
        if (freshSession && color.sessionColor) this.applySessionButtonBackground(freshSession, color.sessionColor);

        // Push avatar colour to the user list tiles (visible before account selection).
        const listAvatarColor = color.avatarColor ?? {
            r: color.r, g: color.g, b: color.b,
            rgba: `rgba(${color.r}, ${color.g}, ${color.b}, 1.0)`,
        };
        if (this._gdm?._avatarManager && listAvatarColor)
            this._gdm._avatarManager.updateAvatarVibrancy(listAvatarColor);
    }
}
