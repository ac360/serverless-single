/**
 * Created by jamesonvallar on 23/03/2016.
 */
'use strict';

/**
 * Serverless Optimizer Plugin
 */

module.exports = function(S) {

    const path    = require('path'),
        _           = require('lodash'),
        fs          = require('fs'),
        browserify  = require('browserify'),
        UglifyJS    = require('uglify-js'),
        wrench      = require('wrench'),
        BbPromise   = require('bluebird');

    /**
     * ServerlessOptimizer
     */

    class ServerlessOptimizer extends S.classes.Plugin {

        /**
         * Constructor
         */

        constructor() {
            super();
        }

        /**
         * Define your plugins name
         */

        static getName() {
            return 'com.serverless.' + ServerlessOptimizer.name;
        }

        /**
         * Register Hooks
         */

        registerHooks() {

            S.addHook(this._optimize.bind(this), {
                action: 'codeDeployLambda',
                event: 'pre'
            });

            return BbPromise.resolve();
        }

        /**
         * Optimize
         */

        _optimize(evt) {

            // Validate: Check Serverless version
            // TODO: Use a full x.x.x version string. Consider using semver: https://github.com/npm/node-semver
            if (parseInt(S._version.split('.')[1]) < 5) {
                console.log("WARNING: This version of the Serverless Optimizer Plugin will not work with a version of Serverless that is less than v0.5");
            }

            // Get function
            let func    = S.getProject().getFunction(evt.options.name),
                optimizer;

            // Skip if no optimization is set on function
            if (!func.custom || !func.custom.optimize) {
                return BbPromise.resolve(evt);
            }

            // Skip if disable is true in function
            if (func.custom && func.custom.optimize && func.custom.optimize.disable) {
                return BbPromise.resolve(evt);
            }

            // If component/function has an excludeStage value matching the current, skip
            let excludeStage = [];

            // Cycle through function and combine values

            // If excludeStage was set
            if (_.has(func, "custom.optimize.excludeStage")) {
                // If excludeStage is a string or array, combine with exclude array. Function will overwrite component settings.
                if (_.isString(func.custom.optimize.excludeStage) || _.isArray(func.custom.optimize.excludeStage)) {
                    excludeStage = _.concat([], func.custom.optimize.excludeStage);
                }
                // If excludeStage is bool and false, clear the array.
                if (_.isBoolean(func.custom.optimize.excludeStage) && func.custom.optimize.excludeStage === false) {
                    excludeStage = [];
                }
            }

            // If current stage was excluded, skip
            if (_.includes(excludeStage, evt.options.stage)) {
                return BbPromise.resolve(evt);
            }

            // If function has an excludeRegion value matching the current, skip
            let excludeRegion = [];

            // If excludeRegion was set
            if (_.has(func, "custom.optimize.excludeRegion")) {
                // If excludeRegion is a string or array, combine with exclude array. Function will overwrite component settings.
                if (_.isString(func.custom.optimize.excludeRegion) || _.isArray(func.custom.optimize.excludeRegion)) {
                    excludeRegion = _.concat([], func.custom.optimize.excludeRegion);
                }
                // If excludeRegion is bool and false, clear the array.
                if (_.isBoolean(func.custom.optimize.excludeRegion) && func.custom.optimize.excludeRegion === false) {
                    excludeRegion = [];
                }
            }

            // If current region was excluded, skip
            if (_.includes(excludeRegion, evt.options.region)) {
                return BbPromise.resolve(evt);
            }

            // Optimize: Nodejs
            if (func.getRuntime().getName() === 'nodejs') {
                optimizer = new OptimizeNodejs(S, evt, func);
                return optimizer.optimize()
                    .then(function(evt) {
                        return evt;
                    });
            }

            // Otherwise, skip plugin
            return BbPromise.resolve(evt);
        }
    }

    /**
     * Optimize Nodejs
     * - Separate class allows this Hook to be run concurrently safely.
     */

    class OptimizeNodejs {

        constructor(S, evt, func) {
            this.evt        = evt;
            this.function   = func;
        }

        optimize() {

            let _this = this;

            _this.config = {
                handlerExt:   'js',
                includePaths: [],
                requires:     [],
                plugins:      [],
                transforms:   [],
                exclude:      [],
                ignore:       [],
                extensions:   []
            };
            _this.config = _.merge(
                _this.config,
                _this.function.custom.optimize ? _this.function.custom.optimize === true ? {} : _this.function.custom.optimize : {}
            );

            // Browserify
            return _this.browserify()
                .then(function() {
                    return _this.evt;
                });
        }

        /**
         * Browserify
         * - Options: transform, exclude, minify, ignore
         */

        browserify() {

            let _this       = this;
            let uglyOptions = {
                mangle:   true, // @see http://lisperator.net/uglifyjs/compress
                compress: {}
            };
            const handlerName = this.function.getHandler();

            let b = browserify({
                basedir:          fs.realpathSync(_this.evt.options.pathDist),
                entries:          [handlerName.split('.')[0] + '.' + _this.config.handlerExt],
                standalone:       'lambda',
                extensions:       _this.config.extensions,
                browserField:     false,  // Setup for node app (copy logic of --node in bin/args.js)
                builtins:         false,
                commondir:        false,
                ignoreMissing:    true,  // Do not fail on missing optional dependencies
                detectGlobals:    true,  // Default for bare in cli is true, but we don't care if its slower
                insertGlobalVars: {      // Handle process https://github.com/substack/node-browserify/issues/1277
                    //__filename: insertGlobals.lets.__filename,
                    //__dirname: insertGlobals.lets.__dirname,
                    process: function () {
                    }
                }
            });

            // browserify.require
            _this.config.requires.map(req => {
                if (typeof(req) === typeof('')) req = {name: req};
            b.require(req.name, req.opts);
        });

            // browserify.plugin
            _this.config.plugins.map(plug => {
                if (typeof(plug) === typeof('')) plug = {name: plug};
            b.plugin(require(plug.name), plug.opts);
        });

            // browserify.transform
            _this.config.transforms.map(transform => {
                if (typeof(transform) === typeof('')) transform = {name: transform};
            b.transform(require(transform.name), transform.opts);
        });

            // browserify.exclude
            _this.config.exclude.forEach(file => b.exclude(file));

            // browserify.ignore
            _this.config.ignore.forEach(file => b.ignore(file));

            // Perform Bundle
            return new BbPromise(function (resolve, reject) {

                    b.bundle(function (err, bundledBuf) {

                        // Reset pathDist
                        _this.optimizedDistPath = path.join(_this.evt.options.pathDist, 'optimized');

                        // Set path of optimized file
                        let optimizedFile = path.join(_this.optimizedDistPath, _this.function.getHandler().split('.')[0] + '.js');

                        if (err) {
                            console.error('Error running browserify bundle');
                            reject(err);
                        } else {

                            // Write bundled file
                            S.utils.writeFileSync(optimizedFile, bundledBuf);

                            // Minify browserified data
                            if (_this.config.minify !== false) {

                                let result = UglifyJS.minify(optimizedFile, uglyOptions);

                                if (!result || !result.code) return reject(new SError('Problem uglifying code'));

                                S.utils.writeFileSync(optimizedFile, result.code);

                                resolve(optimizedFile);
                            } else {
                                resolve(optimizedFile);
                            }
                        }
                    });
                })
                    .then(optimizedFile => {

                    let includePaths = _this.function.custom.optimize.includePaths;

            if (includePaths && includePaths.length) {
                includePaths.forEach(function(p) {

                    wrench.mkdirSyncRecursive(path.join(_this.optimizedDistPath, p), '0777');
                    wrench.copyDirSyncRecursive(
                        path.join(_this.evt.options.pathDist, p),
                        path.join(_this.optimizedDistPath, p), {
                            forceDelete: true
                        }
                    );
                });
            }

            _this.evt.options.pathDist = _this.optimizedDistPath;

        });
        }
    }

    return ServerlessOptimizer;
};