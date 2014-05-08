'use strict';

var path = require('path')
  , fs = require('fs');

/**
 * Temper compiles templates to client-side compatible templates as well as it's
 * server side equivalents.
 *
 * @constructor
 * @param {Object} options Temper configuration.
 * @api public
 */
function Temper(options) {
  options = options || {};

  options.cache = 'cache' in options
    ? options.cache
    : process.env.NODE_ENV !== 'production';

  this.cache = options.cache;             // Cache compiled templates.
  this.installed = Object.create(null);   // Installed module for extension cache.
  this.required = Object.create(null);    // Template engine require cache.
  this.compiled = Object.create(null);    // Compiled template cache.
  this.timers = Object.create(null);      // Keep track of timeouts.
  this.file = Object.create(null);        // File lookup cache.
}

/**
 * List of supported templates engines mapped by file extension for easy
 * detection.
 *
 * @type {Object}
 * @private
 */
Temper.prototype.supported = {
  '.ejs': ['ejs'],
  '.jade': ['jade'],
  '.mustache': ['hogan.js', 'mustache', 'handlebars'],
  '.hbs': ['handlebars'],
  '.handlebars': ['handlebars'],
  '.html': ['html']
};

/**
 * Require a cached require, or require it normally.
 *
 * @param {String} engine Module name.
 * @return {Mixed} The module.
 * @api private
 */
Temper.prototype.require = function requires(engine) {
  if (engine in this.required) return this.required[engine];

  var temper = this;

  try { this.required[engine] = 'html' !== engine ? require(engine) : null; }
  catch (e) {
    throw new Error('The '+ engine +' module isn\'t installed. Run npm install --save '+ engine);
  }

  //
  // Release the cached template compilers again, there is no need to keep it.
  //
  this.timers.require = setTimeout(function cleanup() {
    delete temper.required[engine];
    delete temper.timers.require;
  }, 5 * 60 * 1000);

  return this.required[engine];
};

/**
 * Reads a file in to the cache and returns the contents.
 *
 * @param {String} file The absolute location of a file.
 * @returns {String} The file contents.
 * @api private
 */
Temper.prototype.read = function read(file) {
  if (file in this.file) return this.file[file];

  var temper = this;

  //
  // Temporarily store the file in our cache. Remove it after a while because
  // we're going to compile the source to a template function anyways so this
  // will no longer serve it's use.
  //
  this.file[file] = fs.readFileSync(file, 'utf-8');

  this.timers.read = setTimeout(function cleanup() {
    delete temper.file[file];
    delete temper.timers.read;
  }, 60 * 1000);

  return this.file[file];
};

/**
 * Prefetch a new template in to the cache.
 *
 * @param {String} file The file that needs to be compiled.
 * @param {String} engine The engine we need to use.
 * @api public
 */
Temper.prototype.prefetch = function prefetch(file, engine) {
  if (file in this.compiled) return this.compiled[file];

  var name = this.normalizeName(file)
    , template = this.read(file)
    , compiled;

  engine = engine || this.discover(file);

  //
  // Now that we have all required information we can compile the template in to
  // different sections.
  //
  compiled = this.compile(template, engine, name, file);

  if (!this.cache) return compiled;
  return this.compiled[file] = compiled;
};

/**
 * Convert the filename into a safe javascript function name
 *
 * @param {String} file The name of the file to convert into a safe function name
 * @returns {String} Name to use for the template function in certain supporting compilers.
 * @api private
 */
Temper.prototype.normalizeName = function(file) {
    var name = path.basename(file, path.extname(file));

    // remove leading numbers
    name = name.replace(/^[0-9]+/, '');

    // remove all but alphanumeric or _ or $
    return name.replace(/[^\w$]/g, '');
};

/**
 * Fetch a compiled version of a template.
 *
 * @param {String} file The file that needs to be compiled.
 * @param {String} engine The engine we need to use.
 * @api public
 */
Temper.prototype.fetch = function fetch(file, engine) {
  return this.compiled[file] || this.prefetch(file, engine);
};

/**
 * Discover which template engine we need to use for the given file path.
 *
 * @param {String} file The filename.
 * @returns {String} Name of the template engine.
 * @api private
 */
Temper.prototype.discover = function discover(file) {
  var extname = path.extname(file)
    , list = this.supported[extname]
    , temper = this
    , found;

  //
  // Already found a working template engine for this extensions. Use this
  // instead of trying to require more pointless template engines.
  //
  if (extname in this.installed) return this.installed[extname];

  //
  // A unknown file extension, we have no clue how to process this, so throw.
  //
  if (!list) throw new Error('Unknown file extension. '+ extname + ' is not supported');

  found = list.filter(function filter(engine) {
    var compiler;

    try { compiler = temper.require(engine); }
    catch (e) { return false; }

    temper.required[engine] = compiler;
    temper.installed[extname] = engine;

    return true;
  });

  if (found.length) return found[0];

  //
  // We couldn't find any valid template engines for the given file. Prompt the
  // user to install one of our supported template engines.
  //
  throw new Error('No compatible template engine installed, please run: npm install --save '+ list[0]);
};

/**
 * Compile a given template to a server side and client side component.
 *
 * @param {String} template The templates content.
 * @param {String} engine The name of the template engine.
 * @param {String} name The filename without extension.
 * @param {String} filename The full filename
 * @returns {Object}
 * @api private
 */
Temper.prototype.compile = function compile(template, engine, name, filename) {
  var compiler = this.require(engine)
    , library, directory, server, client;

  switch (engine) {
    case 'hogan.js':
      //
      // Create a unform interface for the server, which is a function that just
      // receieves data and renders a template. So we need to create a closure
      // as binding data is fucking slow.
      //
      server = (function hulk(template) {
        return function render(data) {
          return template.render(data);
        };
      })(compiler.compile(template));

      //
      // Create a uniform interface for the client, same as for the server, we
      // need to wrap it in a closure.
      //
      client = [
        '(function hulk() {',
          'var template = new Hogan.Template(',
            compiler.compile(template, { asString: 1 }),
          ');',
        'return function render(data) { return template.render(data); };'
      ].join('');

      directory = path.dirname(require.resolve(engine));
      library = path.join(directory, 'template.js');
    break;

    case 'handlebars':
      server = compiler.compile(template);
      client = compiler.precompile(template);

      directory = path.dirname(require.resolve(engine));
      library = path.join(directory, '..', 'dist', 'handlebars.runtime.js');
    break;

    case 'ejs':
      server = compiler.compile(template, {
        filename: filename      // Used for debugging.
      });

      //
      // Compiling a client is just as simple as for the server, it just
      // requires a little bit of .toString() magic to make it work.
      //
      client = compiler.compile(template, {
        client: true,           // Ensure we export it for client usage.
        compileDebug: false,    // No debug code plx.
        filename: filename      // Used for debugging.
      }).toString().replace('function anonymous', 'function ' + name);
    break;

    case 'jade':
      server = compiler.compile(template, {
        filename: filename      // Required for includes and used for debugging.
      });

      //
      // Compiling a client is just as simple as for the server, it just
      // requires a little bit of .toString() magic to make it work.
      //
      client = (compiler.compileClient || compiler.compile)(template, {
        client: true,           // Required for older Jade versions.
        pretty: false,          // Prevent pretty code as it inserts unwanted data.
        compileDebug: false,    // No debug code plx.
        filename: filename      // Required for includes and used for debugging.
      }).toString().replace('function anonymous', 'function ' + name);

      directory = path.dirname(require.resolve(engine));
      library = path.join(directory, 'runtime.js');
    break;

    case 'html':
      //
      // We need to JSON.stringify the template to prevent it from throwing
      // errors.
      //
      client = (new Function(
        'return '+ JSON.stringify(template)
      )).toString().replace('function anonymous', 'function ' + name);

      server = function render() {
        return template;
      };
    break;
  }

  return {
    library: library ? this.read(library) : '',   // Front-end library.
    client: client,                               // Pre-compiled code.
    server: server,                               // Compiled template.
    engine: engine                                // The engine's name.
  };
};

/**
 * Destroy.
 *
 * @api public
 */
Temper.prototype.destroy = function destroy() {
  Object.keys(this.timers).forEach(function each(timer) {
    clearTimeout(this.timers[timer]);
    delete this.timers[timer];
  }, this);

  this.installed = this.required = this.compiled = this.file = this.timers = null;
};

//
// Expose temper.
//
module.exports = Temper;
