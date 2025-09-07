// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported SwipeTracker */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import { SwipeTracker } from 'resource:///org/gnome/shell/ui/swipeTracker.js';

// FIXME: ideally these values matches physical touchpad size. We can get the
// correct values for gnome-shell specifically, since mutter uses libinput
// directly, but GTK apps cannot get it, so use an arbitrary value so that
// it's consistent with apps.
const TOUCHPAD_BASE_HEIGHT = 300;

const SCROLL_MULTIPLIER = 10;

const VELOCITY_THRESHOLD_TOUCH = 0.3;
const VELOCITY_THRESHOLD_TOUCHPAD = 0.6;
const DECELERATION_TOUCH = 0.998;
const DECELERATION_TOUCHPAD = 0.997;
const VELOCITY_CURVE_THRESHOLD = 2;
const DECELERATION_PARABOLA_MULTIPLIER = 0.35;

/** @enum {number} */
const State = {
    NONE: 0,
    SCROLLING: 1,
};

const MouseScroll = GObject.registerClass({
    Properties: {
        'enabled': GObject.ParamSpec.boolean(
            'enabled', 'enabled', 'enabled',
            GObject.ParamFlags.READWRITE,
            true),
        },
    Signals: {
        'begin':  { param_types: [GObject.TYPE_UINT, GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE] },
        'update': { param_types: [GObject.TYPE_UINT, GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE] },
        'end':    { param_types: [GObject.TYPE_UINT, GObject.TYPE_DOUBLE] },
    },
}, class MouseScroll extends GObject.Object {
    constructor(actor) {
        super();
        this._began = false;
        this._enabled = true;
        this._gestureTimeoutId = 0;
        actor.connect('scroll-event', this._handleEvent.bind(this));
    }

    get enabled() {
        return this._enabled;
    }

    set enabled(enabled) {
        if (this._enabled === enabled)
            return;
        const distance = TOUCHPAD_BASE_HEIGHT;
        this._enabled = enabled;
        this._began = false;
        if (enabled === false && this._gestureTimeoutId !== 0) {
            GLib.Source.remove(this._gestureTimeoutId)
            this._gestureTimeoutId = 0;
            this.emit('end', Clutter.get_current_event_time(), distance);
        }
        this.notify('enabled');
    }

    canHandleEvent(event) {
        if (event.type() !== Clutter.EventType.SCROLL)
           return false;

        if (event.get_scroll_source() === Clutter.ScrollSource.FINGER ||
            event.get_source_device().get_device_type() === Clutter.InputDeviceType.TOUCHPAD_DEVICE)
            return false;

        if (!this.enabled)
            return false;

        return true;
    }

    _handleEvent(actor, event) {
        if (!this.canHandleEvent(event))
            return Clutter.EVENT_PROPAGATE;

        if (event.get_scroll_direction() !== Clutter.ScrollDirection.SMOOTH)
            return Clutter.EVENT_PROPAGATE;

        const distance = TOUCHPAD_BASE_HEIGHT;

        let time = event.get_time();
        this._lastTime = time;
        let [dx, dy] = event.get_scroll_delta();

        if (!this._began) {
            let [x, y] = event.get_coords();
            this.emit('begin', time, x, y);
            this._began = true;
        }

        const delta = dx * 2* SCROLL_MULTIPLIER + dy * SCROLL_MULTIPLIER;
        if (this._gestureTimeoutId !== 0) {
            GLib.Source.remove(this._gestureTimeoutId);
            this._gestureTimeoutId = 0;
        }
        this._gestureTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this.emit('end', Clutter.get_current_event_time(), distance);
            this._began = false;
            this._gestureTimeoutId = 0;
            return false;
        });

        this.emit('update', time, delta, distance);

        return Clutter.EVENT_STOP;
    }

    destroy() {
        if (this._gestureTimeoutId !== 0) {
            GLib.Source.remove(this._gestureTimeoutId);
            this._gestureTimeoutId = 0;
        }
    }

});

// USAGE:
//
// To correctly implement the gesture, there must be handlers for the following
// signals:
//
// begin(tracker, monitor)
//   The handler should check whether a deceleration animation is currently
//   running. If it is, it should stop the animation (without resetting
//   progress). Then it should call:
//   tracker.confirmSwipe(distance, snapPoints, currentProgress, cancelProgress)
//   If it's not called, the swipe would be ignored.
//   The parameters are:
//    * distance: the page size;
//    * snapPoints: an (sorted with ascending order) array of snap points;
//    * currentProgress: the current progress;
//    * cancelprogress: a non-transient value that would be used if the gesture
//      is cancelled.
//   If no animation was running, currentProgress and cancelProgress should be
//   same. The handler may set 'orientation' property here.
//
// update(tracker, progress)
//   The handler should set the progress to the given value.
//
// end(tracker, duration, endProgress)
//   The handler should animate the progress to endProgress. If endProgress is
//   0, it should do nothing after the animation, otherwise it should change the
//   state, e.g. change the current page or switch workspace.
//   NOTE: duration can be 0 in some cases, in this case it should finish
//   instantly.

/**
 * A custom class for handling swipe gestures.
 *
 * @see https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/swipeTracker.js Base SwipeTracker
 */
export const MySwipeTracker = GObject.registerClass(class MySwipeTracker extends SwipeTracker {
    constructor(actor, settings, inverted = false) {
        const allowDrag = true;
        const allowScroll = true;

        super(actor, Clutter.Orientation.HORIZONTAL, Shell.ActionMode.ALL, { allowDrag, allowScroll });
        this._settings = settings;
        this._inverted = inverted;
        this._allowDrag = allowDrag;

        if (allowScroll) {
            this._mouseScroll = new MouseScroll(actor);
            this._mouseScroll.connect('begin', this._beginTouchpadGesture.bind(this));
            this._mouseScroll.connect('update', this._updateTouchpadGesture.bind(this));
            this._mouseScroll.connect('end', this._endTouchpadGesture.bind(this));
            this.bind_property('enabled', this._mouseScroll, 'enabled', 0);
        } else {
            this._mouseScroll = null;
        }
    }

    /**
     * canHandleScrollEvent:
     * This function can be used to combine swipe gesture and mouse
     * scrolling.
     *
     * @param {Clutter.Event} scrollEvent an event to check
     * @returns {boolean} whether the event can be handled by the tracker
     */
    canHandleScrollEvent(scrollEvent) {
        if (!this.enabled || (this._scrollGesture === null && this._mouseScroll === null)) {
            return false;
        }

        return this._scrollGesture.canHandleEvent(scrollEvent) || this._mouseScroll.canHandleEvent(scrollEvent);
    }

    _updatePanGesture(panGesture) {
        const deltaVec = panGesture.get_delta_abs();
        let delta = this.orientation === Clutter.Orientation.HORIZONTAL
            ? -deltaVec.get_x()
            : -deltaVec.get_y();

        if (this._allowDrag && this._settings.natural_scrolling) {
            delta = -delta;
        }
        this._updateGesture(delta, this._distance);
    }

    _updateGesture(delta, distance) {
        if (this._state !== State.SCROLLING)
            return;

        if (this.orientation === Clutter.Orientation.HORIZONTAL &&
            Clutter.get_default_text_direction() === Clutter.TextDirection.RTL)
            delta = -delta;

        if (this._inverted) {
            delta = -delta;
        }

        this._progress += delta / distance;

        if (this._settings.switcher_style === "Timeline" ||
            this._settings.switcher_looping_method === "Carousel") {
            this._progress = (this._progress + this._snapPoints.length) % this._snapPoints.length;
        } else {
            this._progress = Math.clamp(this._progress, ...this._getBounds(this._initialProgress));
        }
        this.emit('update', this._progress);
    }

    _getEndProgress(velocity, distance, isTouchpad) {
        if (this._cancelled)
            return this._cancelProgress;

        const threshold = isTouchpad ? VELOCITY_THRESHOLD_TOUCHPAD : VELOCITY_THRESHOLD_TOUCH;

        if (Math.abs(velocity) < threshold)
            return this._snapPoints[this._findClosestPoint(this._progress)];

        const decel = isTouchpad ? DECELERATION_TOUCHPAD : DECELERATION_TOUCH;
        const slope = decel / (1.0 - decel) / 1000.0;

        let pos;
        if (Math.abs(velocity) > VELOCITY_CURVE_THRESHOLD) {
            const c = slope / 2 / DECELERATION_PARABOLA_MULTIPLIER;
            const x = Math.abs(velocity) - VELOCITY_CURVE_THRESHOLD + c;

            pos = slope * VELOCITY_CURVE_THRESHOLD +
                DECELERATION_PARABOLA_MULTIPLIER * x * x -
                DECELERATION_PARABOLA_MULTIPLIER * c * c;
        } else {
            pos = Math.abs(velocity) * slope;
        }

        pos = pos * Math.sign(velocity) + this._progress;
        if (this._settings.switcher_style === "Timeline" ||
            this._settings.switcher_looping_method === "Carousel") {
            pos = (pos + this._snapPoints.length) % this._snapPoints.length;
        } else {
            pos = Math.clamp(pos, ...this._getBounds(this._initialProgress));
        }

        const index = this._findPointForProjection(pos, velocity);

        return this._snapPoints[index];
    }

    destroy() {
        super.destroy();

        if (this._mouseScroll) {
            this._mouseScroll.destroy();
            delete this._mouseScroll;
        }
    }
});
