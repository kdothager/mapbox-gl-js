// @flow

import {bindAll, isWorker, isSafari} from './util';
import window from './window';
import browser from './browser';
import {serialize, deserialize} from './web_worker_transfer';
import ThrottledInvoker from './throttled_invoker';

import type {Transferable} from '../types/transferable';
import type {Cancelable} from '../types/cancelable';

// Upper limit on time in ms, the actor allocates towards flushing the task queue per frame
const MAIN_THREAD_TIME_BUDGET = 1;
// Upper limit of number of tasks executed in the a frame in the main thread
const MAIN_THREAD_TASK_BUDGET = 8;

/**
 * An implementation of the [Actor design pattern](http://en.wikipedia.org/wiki/Actor_model)
 * that maintains the relationship between asynchronous tasks and the objects
 * that spin them off - in this case, tasks like parsing parts of styles,
 * owned by the styles
 *
 * @param {WebWorker} target
 * @param {WebWorker} parent
 * @param {string|number} mapId A unique identifier for the Map instance using this Actor.
 * @private
 */
class Actor {
    target: any;
    parent: any;
    mapId: ?number;
    callbacks: { number: any };
    name: string;
    tasks: { number: any };
    taskQueue: Array<number>;
    cancelCallbacks: { number: Cancelable };
    invoker: ThrottledInvoker;
    globalScope: any;
    isWorker: boolean;

    constructor(target: any, parent: any, mapId: ?number) {
        this.target = target;
        this.parent = parent;
        this.mapId = mapId;
        this.isWorker = isWorker();
        this.callbacks = {};
        this.tasks = {};
        this.taskQueue = [];
        this.cancelCallbacks = {};
        bindAll(['receive', 'process'], this);
        this.invoker = new ThrottledInvoker(this.process);
        this.target.addEventListener('message', this.receive, false);
        this.globalScope = isWorker ? target : window;
    }

    /**
     * Sends a message from a main-thread map to a Worker or from a Worker back to
     * a main-thread map instance.
     *
     * @param type The name of the target method to invoke or '[source-type].[source-name].name' for a method on a WorkerSource.
     * @param targetMapId A particular mapId to which to send this message.
     * @private
     */
    send(type: string, data: mixed, callback: ?Function, targetMapId: ?string): ?Cancelable {
        // We're using a string ID instead of numbers because they are being used as object keys
        // anyway, and thus stringified implicitly. We use random IDs because an actor may receive
        // message from multiple other actors which could run in different execution context. A
        // linearly increasing ID could produce collisions.
        const id = Math.round((Math.random() * 1e18)).toString(36).substring(0, 10);
        if (callback) {
            this.callbacks[id] = callback;
        }
        const buffers: ?Array<Transferable> = isSafari(this.globalScope) ? undefined : [];
        this.target.postMessage({
            id,
            type,
            hasCallback: !!callback,
            targetMapId,
            sourceMapId: this.mapId,
            data: serialize(data, buffers)
        }, buffers);
        return {
            cancel: () => {
                if (callback) {
                    // Set the callback to null so that it never fires after the request is aborted.
                    delete this.callbacks[id];
                }
                this.target.postMessage({
                    id,
                    type: '<cancel>',
                    targetMapId,
                    sourceMapId: this.mapId
                });
            }
        };
    }

    receive(message: Object) {
        const data = message.data,
            id = data.id;

        if (!id) {
            return;
        }

        if (data.targetMapId && this.mapId !== data.targetMapId) {
            return;
        }

        if (data.type === '<cancel>') {
            // Remove the original request from the queue. This is only possible if it
            // hasn't been kicked off yet. The id will remain in the queue, but because
            // there is no associated task, it will be dropped once it's time to execute it.
            delete this.tasks[id];
            const cancel = this.cancelCallbacks[id];
            delete this.cancelCallbacks[id];
            if (cancel) {
                cancel();
            }
        } else {
            // On the main thread, store the tasks that we need to process before actually processing them. This
            // is necessary because we want to keep receiving messages, and in particular, <cancel> messages.
            // By batching and deferring their execution on the main thread, we can preempt them from being sent to the worker at all.
            this.tasks[id] = data;
            this.taskQueue.push(id);
            if (this.isWorker) {
                this.process();
            } else {
                this.invoker.trigger();
            }
        }
    }

    process() {
        if (!this.taskQueue.length) {
            return;
        }

        //If this is a worker actor, then flush the entire task queue since we don't need to wait for
        //cancel messages on the worker side, only on the main thread side, so we have Infinite budget for processing messages.
        const timeBudget = this.isWorker ? Number.MAX_VALUE : MAIN_THREAD_TIME_BUDGET;
        const taskBudget = this.isWorker ? Number.MAX_VALUE : MAIN_THREAD_TASK_BUDGET;

        const start = browser.now();
        let taskCtr = 0;
        while(browser.now() - start < timeBudget && taskCtr < taskBudget && this.taskQueue.length > 0 ){
            this._processQueueTop();
            taskCtr++;
        }
        // We've reached our budget for this frame, defer processingo the rest for the netx frame, this lets
        // the deferred tasks bet preempted on slower browsers.
        if(this.taskQueue.length){
            this.invoker.trigger();
        }
    }

    _processQueueTop() {
        const id = this.taskQueue.shift();
        const task = this.tasks[id];
        delete this.tasks[id];
        // Schedule another process call if we know there's more to process _before_ invoking the
        // current task. This is necessary so that processing continues even if the current task
        // doesn't execute successfully.
        // if (this.taskQueue.length) {
        //     this.invoker.trigger();
        // }
        if (!task) {
            // If the task ID doesn't have associated task data anymore, it was canceled.
            return;
        }
        if (task.type === '<response>') {
            // The done() function in the counterpart has been called, and we are now
            // firing the callback in the originating actor, if there is one.
            const callback = this.callbacks[id];
            delete this.callbacks[id];
            if (callback) {
                // If we get a response, but don't have a callback, the request was canceled.
                if (task.error) {
                    callback(deserialize(task.error));
                } else {
                    callback(null, deserialize(task.data));
                }
            }
        } else {
            let completed = false;
            const buffers: ?Array<Transferable> = isSafari(this.globalScope) ? undefined : [];
            const done = task.hasCallback ? (err, data) => {
                completed = true;
                delete this.cancelCallbacks[id];
                this.target.postMessage({
                    id,
                    type: '<response>',
                    sourceMapId: this.mapId,
                    error: err ? serialize(err) : null,
                    data: serialize(data, buffers)
                }, buffers);
            } : (_) => {
                completed = true;
            };

            let callback = null;
            const params = (deserialize(task.data): any);
            if (this.parent[task.type]) {
                // task.type == 'loadTile', 'removeTile', etc.
                callback = this.parent[task.type](task.sourceMapId, params, done);
            } else if (this.parent.getWorkerSource) {
                // task.type == sourcetype.method
                const keys = task.type.split('.');
                const scope = (this.parent: any).getWorkerSource(task.sourceMapId, keys[0], params.source);
                callback = scope[keys[1]](params, done);
            } else {
                // No function was found.
                done(new Error(`Could not find function ${task.type}`));
            }

            if (!completed && callback && callback.cancel) {
                // Allows canceling the task as long as it hasn't been completed yet.
                this.cancelCallbacks[id] = callback.cancel;
            }
        }
    }

    remove() {
        this.invoker.remove();
        this.target.removeEventListener('message', this.receive, false);
    }
}

export default Actor;
