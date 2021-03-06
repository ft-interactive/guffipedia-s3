/* eslint-disable no-loop-func */

import 'dotenv/config';
import browserify from 'browserify';
import browserSync from 'browser-sync';
import clone from 'gulp-clone';
import del from 'del';
import fetch from 'node-fetch';
import fs from 'fs';
import gulp from 'gulp';
import Handlebars from 'handlebars';
import jsonTransform from 'gulp-json-transform';
import mkdirp from 'mkdirp';
import mergeStream from 'merge-stream';
import path from 'path';
import php from 'phpjs';
import prettyData from 'gulp-pretty-data';
import rename from 'gulp-rename';
import runSequence from 'run-sequence';
import source from 'vinyl-source-stream';
import subdir from 'subdir';
import vinylBuffer from 'vinyl-buffer';
import watchify from 'watchify';
import AnsiToHTML from 'ansi-to-html';

const $ = require('auto-plug')('gulp');
const ansiToHTML = new AnsiToHTML();

const AUTOPREFIXER_BROWSERS = [
  'ie >= 8',
  'ff >= 30',
  'chrome >= 34',
];

const BROWSERIFY_ENTRIES = [
  'scripts/main.js',
];

const BROWSERIFY_TRANSFORMS = [
  'babelify',
  'debowerify',
];

const OTHER_SCRIPTS = [
  'scripts/top.js'
];

let env = 'development';

// function to get an array of objects that handle browserifying
function getBundlers(useWatchify) {
  return BROWSERIFY_ENTRIES.map(entry => {
    var bundler = {
      b: browserify(path.posix.resolve('client', entry), {
        cache: {},
        packageCache: {},
        fullPaths: useWatchify,
        debug: useWatchify
      }),

      execute: function () {
        var stream = this.b.bundle()
          .on('error', function (error) {
            handleBuildError.call(this, 'Error building JavaScript', error);
          })
          .pipe(source(entry.replace(/\.js$/, '.bundle.js')));

        // skip sourcemap creation if we're in 'serve' mode
        if (useWatchify) {
          stream = stream
            .pipe(vinylBuffer())
            .pipe($.sourcemaps.init({loadMaps: true}))
            .pipe($.sourcemaps.write('./'));
        }

        return stream.pipe(gulp.dest('.tmp'));
      }
    };

    // register all the transforms
    BROWSERIFY_TRANSFORMS.forEach(function (transform) {
      bundler.b.transform(transform);
    });

    // upgrade to watchify if we're in 'serve' mode
    if (useWatchify) {
      bundler.b = watchify(bundler.b);
      bundler.b.on('update', function (files) {
        // re-run the bundler then reload the browser
        bundler.execute().on('end', reload);

        // also report any linting errors in the changed file(s)
        gulp.src(files.filter(file => subdir(path.resolve('client'), file))) // skip bower/npm modules
          .pipe($.eslint())
          .pipe($.eslint.format());
      });
    }

    return bundler;
  });
}

function slugify(value) {
  return value.toLowerCase().trim().replace(/ /g, '-').replace(/['\(\)]/g, '');
}

// compresses images (client => dist)
gulp.task('compress-images', () => gulp.src('client/**/*.{jpg,png,gif,svg}')
  .pipe($.imagemin({
    progressive: true,
    interlaced: true,
  }))
  .pipe(gulp.dest('dist'))
);

// minifies JS (.tmp => dist)
gulp.task('minify-js', () => gulp.src('.tmp/**/*.js')
  .pipe($.uglify({output: {inline_script: true}})) // eslint-disable-line camelcase
  .pipe(gulp.dest('dist'))
);

// minifies CSS (.tmp => dist)
gulp.task('minify-css', () => gulp.src('.tmp/**/*.css')
  .pipe($.minifyCss({compatibility: '*'}))
  .pipe(gulp.dest('dist'))
);

// copies over miscellaneous files (client => dist)
gulp.task('copy-misc-files', () => gulp.src(
  [
    'client/**/*',
    '!client/**/*.{html,scss,js,jpg,png,gif,svg,hbs}', // all handled by other tasks,
  ], {dot: true})
  .pipe(gulp.dest('dist'))
);

// inlines short scripts/styles and minifies HTML (dist => dist)
gulp.task('finalise-html', done => {
  gulp.src('.tmp/**/*.html')
    .pipe(gulp.dest('dist'))
    .on('end', () => {
      gulp.src('dist/**/*.html')
        .pipe($.smoosher())
        .pipe($.minifyHtml())
        .pipe(gulp.dest('dist'))
        .on('end', done);
    });
});

// clears out the dist and .tmp folders
gulp.task('clean', del.bind(null, ['.tmp/*', 'dist/*', '!dist/.git'], {dot: true}));

// // runs a development server (serving up .tmp and client)
gulp.task('serve', ['download-data', 'styles'], function (done) {
  var bundlers = getBundlers(true);

  // execute all the bundlers once, up front
  var initialBundles = mergeStream(bundlers.map(function (bundler) {
    return bundler.execute();
  }));
  initialBundles.resume(); // (otherwise never emits 'end')

  initialBundles.on('end', function () {
    // use browsersync to serve up the development app
    browserSync({
      server: {
        baseDir: ['.tmp', 'client'],
        routes: {
          '/bower_components': 'bower_components'
        }
      }
    });

    // refresh browser after other changes
    gulp.watch(['client/styles/**/*.{scss,css}'], ['styles', 'scsslint', reload]);
    gulp.watch(['client/images/**/*'], reload);

    gulp.watch(['./client/**/*.hbs', 'client/words.json'], () => {
      runSequence('templates', reload);
    });

    runSequence('templates', done);
  });
});

// builds and serves up the 'dist' directory
gulp.task('serve:dist', ['build'], done => {
  require('browser-sync').create().init({
    open: false,
    notify: false,
    server: 'dist',
  }, done);
});

// preprocess/copy scripts (client => .tmp)
// (this is part of prod build task; not used during serve)
gulp.task('scripts', () => mergeStream([
  // bundle browserify entries
  getBundlers().map(bundler => bundler.execute()),
  // also copy over 'other' scripts
  gulp.src(OTHER_SCRIPTS.map(script => 'client{/_hack,}/' + script)).pipe(gulp.dest('.tmp'))
]));

// builds stylesheets with sass/autoprefixer
gulp.task('styles', () => gulp.src('client/**/*.scss')
  .pipe($.sourcemaps.init())
  .pipe($.sass({includePaths: 'bower_components'})
    .on('error', function (error) {
      handleBuildError.call(this, 'Error building Sass', error);
    })
  )
  .pipe($.autoprefixer({browsers: AUTOPREFIXER_BROWSERS}))
  .pipe($.sourcemaps.write('./'))
  .pipe(gulp.dest('.tmp'))
);

// lints JS files
gulp.task('eslint', () => gulp.src('client/scripts/**/*.js')
  .pipe($.eslint())
  .pipe($.eslint.format())
  .pipe($.if(env === 'production', $.eslint.failAfterError()))
);

// lints SCSS files
gulp.task('scsslint', () => gulp.src('client/styles/**/*.scss')
  .pipe($.scssLint({bundleExec: true}))
  .pipe($.if(env === 'production', $.scssLint.failReporter()))
);

// makes a production build (client => dist)
gulp.task('build', done => {
  env = 'production';

  runSequence(
    // preparatory
    ['clean', /* 'scsslint', 'eslint', */ 'download-data'],
    // preprocessing (client/templates => .tmp)
    ['scripts', 'styles', 'templates'],
    // optimisation (+ copying over misc files) (.tmp/client => dist)
    ['minify-js', 'minify-css', 'compress-images', 'copy-misc-files'],
    // finalise the HTML in dist (by inlining small scripts/stylesheets then minifying the HTML)
    ['finalise-html'],
    // create RSS feed in dist
    ['create-rss-feed'],
  done);
});

// downloads the data from bertha to client/words.json
const SPREADSHEET_URL = `https://bertha.ig.ft.com/republish/publish/gss/${process.env.SPREADSHEET_KEY}/data`;
gulp.task('download-data', () => fetch(SPREADSHEET_URL)
  .then(res => res.json())
  .then(spreadsheet => {
    const words = {};

    for (const row of spreadsheet) {

      row.slug = slugify(row.word);

      if (words[row.slug]) throw new Error('Already exists: ' + row.slug);

      words[row.slug] = row;
    }

    let wordArray = Object.keys(words);

    let slugIndex = wordArray.sort();

    const sortedWords = {};

    for (const word of wordArray) {
      sortedWords[word] = words[word];
    }

    for (const row of spreadsheet) {
      let currentSlug = slugify(row.word);
      let currentWord = words[currentSlug];

      currentWord.relatedwords = currentWord.relatedwords.map(relatedWord => {
        if (!words[slugify(relatedWord)]) {
          console.log('%s doesnt exist', relatedWord);
          return;
        }
        return {
        slug: slugify(relatedWord),
        word: words[slugify(relatedWord)].word
      }}).filter(Boolean);

      let slugPointer = null;

      if (slugIndex.indexOf(currentSlug) > 0) {
        slugPointer = slugIndex.indexOf(currentSlug) - 1;
      } else {
        slugPointer = slugIndex.length - 1;
      }

      currentWord.previousWord = {
        slug: words[slugIndex[slugPointer]].slug,
        word: words[slugIndex[slugPointer]].word
      };

      if (slugIndex.indexOf(currentSlug) < slugIndex.length - 1) {
        slugPointer = slugIndex.indexOf(currentSlug) + 1;
      } else {
        slugPointer = 0;
      }

      currentWord.nextWord = {
        slug: words[slugIndex[slugPointer]].slug,
        word: words[slugIndex[slugPointer]].word
      };

      currentWord.showPerpetratorData = currentWord.perpetrator
                                              || currentWord.usagesource ? true : null;
      if(currentWord.wordid) {
        currentWord.wordid = currentWord.wordid.substring(4,currentWord.wordid.length);
      }

      currentWord.formatteddate = php.date('F j, Y', php.strtotime(currentWord.submissiondate));
      currentWord.pubdate = php.date('r', php.strtotime(currentWord.submissiondate));

      const tweetTextString = `“${currentWord.word}”: Corporate language crime no. ${currentWord.wordid} https://ig.ft.com/sites/guffipedia/${currentSlug}`;
      const tweetTextRSSTemplate = Handlebars.compile('{{tweetText}}');
      currentWord.tweettextrss = tweetTextRSSTemplate({tweetText: tweetTextString});
      currentWord.tweettexturi = encodeURI(tweetTextString);
    }

    fs.writeFileSync('client/words.json', JSON.stringify(sortedWords, null, 2));

    let dateIndex = wordArray.sort(function (a, b) {
      return new Date(words[b].submissiondate) - new Date(words[a].submissiondate);
    });

    const homewords = {};

    homewords[dateIndex[0]] = words[dateIndex[0]];

    let randomNumber = Math.floor(Math.random() * (dateIndex.length - 1)) + 1;
    homewords[dateIndex[randomNumber]] = words[dateIndex[randomNumber]];

    fs.writeFileSync('client/homewords.json', JSON.stringify(homewords, null, 2));
  })
);

gulp.task('templates', () => {
  Handlebars.registerPartial('top', fs.readFileSync('client/top.hbs', 'utf8'));
  Handlebars.registerPartial('bottom', fs.readFileSync('client/bottom.hbs', 'utf8'));

  const definitionPageTemplate = Handlebars.compile(fs.readFileSync('client/definition-page.hbs', 'utf8'));

  const words = JSON.parse(fs.readFileSync('client/words.json', 'utf8'));

  for (const slug of Object.keys(words)) {
    const word = words[slug];
    const definitionPageHtml = definitionPageTemplate({
      trackingEnv: (env === 'production' ? 'p' : 't'),
      page: "definition",
      word
    });

    mkdirp.sync(`.tmp/${slug}`);
    fs.writeFileSync(`.tmp/${slug}/index.html`, definitionPageHtml);
  }

  const homewords = JSON.parse(fs.readFileSync('client/homewords.json', 'utf8'));

  const mainPageTemplate = Handlebars.compile(fs.readFileSync('client/main-page.hbs', 'utf8'));
  const mainPageHtml = mainPageTemplate({
    trackingEnv: (env === 'production' ? 'p' : 't'),
    page: "main",
    homewords,
    words,
  });
  fs.writeFileSync(`.tmp/index.html`, mainPageHtml);

  const thanksPageTemplate = Handlebars.compile(fs.readFileSync('client/thanks-page.hbs', 'utf8'));
  const thanksPageHtml = thanksPageTemplate({
    trackingEnv: (env === 'production' ? 'p' : 't'),
    page: "thanks"
  })
  fs.writeFileSync(`.tmp/thanks.html`, thanksPageHtml);
});

gulp.task('create-rss-feed', () => {
  gulp.src('client/words.json')
  .pipe(clone())
  .pipe(jsonTransform(function(words) {
    let wordArray = Object.keys(words);
    let dateIndex = wordArray.sort(function (a, b) {
      return new Date(words[b].submissiondate) - new Date(words[a].submissiondate);
    });

    const rssTitle = 'Guffipedia';
    const rssLink = 'https://ig.ft.com/sites/guffipedia/';
    const rssDescription = 'Lucy Kellaway’s dictionary of business jargon and corporate nonsense';

    let rssString = '<?xml version="1.0"?>';
    rssString += `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:guff="${rssLink}">`;
    rssString += '<channel>';
    rssString += `<title>${rssTitle}</title>`;
    rssString += `<link>${rssLink}</link>`;
    rssString += `<description>${rssDescription}</description>`;
    rssString += `<atom:link href="${rssLink}rss.xml" rel="self" type="application/rss+xml" />`;
    for (const slug of dateIndex) {
      let currentWord = words[slug];
      rssString += '<item>';
      rssString += `<title>${currentWord.word}</title>`;
      rssString += `<description>${currentWord.tweettextrss}</description>`;
      rssString += `<link>${rssLink}${slug}/</link>`;
      rssString += `<guid>${rssLink}${slug}/</guid>`;
      rssString += `<pubDate>${currentWord.pubdate}/</pubDate>`;
      rssString += `<guff:formatteddate>${currentWord.formatteddate}</guff:formatteddate>`;
      rssString += `<guff:slug>${currentWord.slug}</guff:slug>`;
      rssString += `<guff:wordid>${currentWord.wordid}</guff:wordid>`;
      rssString += `<guff:submissiondate>${currentWord.submissiondate}</guff:submissiondate>`;
      if (currentWord.definition) {
        const definition = htmlEntities(currentWord.definition);
        rssString += `<guff:definition>${definition}</guff:definition>`;
      }
      if (currentWord.usageexample) {
        const usageexample = htmlEntities(currentWord.usageexample);
        rssString += `<guff:usageexample>${usageexample}</guff:usageexample>`;
      }
      if (currentWord.lucycommentary) {
        const lucycommentary = htmlEntities(currentWord.lucycommentary);
        rssString += `<guff:lucycommentary>${lucycommentary}</guff:lucycommentary>`;
      }
      rssString += `<guff:commenturl>${currentWord.commenturl}</guff:commenturl>`;
      if (currentWord.perpetrator) {
        const perpetrator = htmlEntities(currentWord.perpetrator);
        rssString += `<guff:perpetrator>${perpetrator}</guff:perpetrator>`;
      }
      if (currentWord.usagesource) {
        const usagesource = htmlEntities(currentWord.usagesource);
        rssString += `<guff:usagesource>${usagesource}</guff:usagesource>`;
      }
      if (currentWord.sourceurl) {
        const sourceurl = htmlEntities(currentWord.sourceurl);
        rssString += `<guff:sourceurl>${sourceurl}</guff:sourceurl>`;
      }
      rssString += `<guff:tweet>${currentWord.tweettextrss}</guff:tweet>`;
      rssString += '<guff:previousword>';
      rssString += `<guff:slug>${currentWord.previousWord.slug}</guff:slug>`;
      rssString += `<guff:word>${currentWord.previousWord.word}</guff:word>`;
      rssString += '</guff:previousword>';
      rssString += '<guff:nextword>';
      rssString += `<guff:slug>${currentWord.nextWord.slug}</guff:slug>`;
      rssString += `<guff:word>${currentWord.nextWord.word}</guff:word>`;
      rssString += '</guff:nextword>';
      if (currentWord.relatedwords.length > 0) {
        rssString += '<guff:relatedwords>';
        for (const relatedword of currentWord.relatedwords) {
          rssString += '<guff:relatedword>';
          rssString += `<guff:slug>${relatedword.slug}</guff:slug>`;
          rssString += `<guff:word>${relatedword.word}</guff:word>`;
          rssString += '</guff:relatedword>';
        }
        rssString += '</guff:relatedwords>';
      }
      rssString += '</item>';
    }
    rssString += '</channel>';
    rssString += '</rss>';

    return rssString;
  }))
  .pipe(rename('rss.xml'))
  .pipe(gulp.dest('dist'))
});

// helpers

//encode html entities
function htmlEntities(string) {
  const template = Handlebars.compile('{{string}}');
  const html = template({string: string});
  return html;
}

let preventNextReload; // hack to keep a BS error notification on the screen
function reload() {
  if (preventNextReload) {
    preventNextReload = false;
    return;
  }

  browserSync.reload();
}

function handleBuildError(headline, error) {
  if (env === 'development') {
    // show in the terminal
    $.util.log(headline, error && error.stack);

    // report it in browser sync
    let report = `<span style="color:red;font-weight:bold;font:bold 20px sans-serif">${headline}</span>`;
    if (error) report += `<pre style="text-align:left;max-width:800px">${ansiToHTML.toHtml(error.stack)}</pre>`;
    browserSync.notify(report, 60 * 60 * 1000);
    preventNextReload = true;

    // allow the sass/js task to end successfully, so the process can continue
    this.emit('end');
  }
  else throw error;
}
