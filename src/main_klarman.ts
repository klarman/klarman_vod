require('dotenv').config();
import Redis from 'ioredis';
import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import FastifyCors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import chalk from 'chalk';
import { IMovieResult, MOVIES, StreamingServers, TvType } from '@consumet/extensions';
import cache from './utils/cache';
import axios from 'axios'
// var base64 = require('node-base64-image');

export const redis =
  process.env.REDIS_HOST &&
  new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    username: process.env.REDIS_USERNAME,
  });

export const tmdbApi = process.env.apiKey && process.env.apiKey;

// const convertImgToBase64 = (url: string) => {
// 	var canvas = <HTMLCanvasElement | null> document.createElement('CANVAS');
// 	var ctx = canvas!.getContext('2d');
// 	var img = new Image;
// 	img.crossOrigin = 'Anonymous';
// 	img.onload = function() {
// 		canvas!.height = img.height;
// 		canvas!.width = img.width;
//     ctx!.drawImage(img,0,0);
//       var dataURL = canvas!.toDataURL('image/png')
//       console.log(dataURL)
// 	  	// callback.call(this, dataURL);
//         // Clean up
//     canvas = null;
// 	};
//   return url
// 	// img.src = url;
// }


const getImage = async (url: string) => {
  const image = await axios.get(url, {
      responseType: 'arraybuffer'
  });
  const returnedB64 = 'data:image/png;base64,' + Buffer.from(image.data).toString('base64');
  // console.log(returnedB64)
  // return "data:" + image.headers["content-type"] + ";base64," + new Buffer(body).toString('base64');
  return returnedB64
}

// async function urlToBase64(url) {
//   return request.get(url, function (error, response, body) {
//     if (!error && response.statusCode == 200) {
//       return "data:" + response.headers["content-type"] + ";base64," + new Buffer(body).toString('base64');
//     }
//   });
// }


(async () => {
  const PORT = Number(process.env.PORT) || 3000;

  console.log(chalk.green(`Starting server on port ${PORT}... 🚀`));
  if (!process.env.REDIS_HOST)
    console.warn(chalk.yellowBright('Redis not found. Cache disabled.'));
  if (!process.env.tmdbApi)
    console.warn(
      chalk.yellowBright('TMDB api key not found. the TMDB meta route may not work.')
    );

  const fastify = Fastify({
    maxParamLength: 1000,
    logger: true,
  });

  await fastify.register(FastifyCors, {
    origin: '*',
    methods: 'GET',
  });

  const secret = process.env.SECRET!
  fastify.register(fastifyJwt, {
    secret: secret
  })

  if(process.env.ENVIRONMENT! !== 'dev') {
    fastify.addHook("onRequest", async (request, reply) => {
      try {
        await request.jwtVerify()
      } catch (err) {
        reply.send(err)
      }
    })
  }

  try {
    const flixhq = new MOVIES.FlixHQ();

    fastify.get('/main', async (_, rp) => {
      // const tvTrending = await cache.fetch(
      //   redis as Redis,
      //   `flixhq:trending:tv`,
      //   async () => await flixhq.fetchTrendingTvShows(),
      //   60 * 60 * 3
      // )

      const tvTrending = await flixhq.fetchTrendingTvShows()

      const formattedTvTrending = await Promise.all(tvTrending.map(async (item) => {
        return {
          id: item.id,
          title: item.title,
          image: await getImage(item.image!),
          latest_season: (item.season! as string).replace(/SS |S /g, ""),
          latest_episode: (item.latestEpisode! as string).replace(/EP |EPS /g, ""),
          type: "series",
          info_url: process.env.BASE_URL! + '/info?id=' + item.id
        }
      }))


      // const formattedTvTrending = tvTrending.map(async (item) => {
      //   return {
      //     id: item.id,
      //     title: item.title,
      //     image: item.image!,
      //     latest_season: (item.season! as string).replace(/SS |S /g, ""),
      //     latest_episode: (item.latestEpisode! as string).replace(/EP |EPS /g, ""),
      //     type: "series",
      //     info_url: process.env.BASE_URL! + '/info?id=' + item.id
      //   }
      // })

      const moviesTrending = await cache.fetch(
        redis as Redis,
        `flixhq:trending:movies`,
        async () => await flixhq.fetchTrendingMovies(),
        60 * 60 * 3
      )

      const formattedMoviesTrending = moviesTrending.map((item) => {
        return {
          id: item.id,
          title: item.title,
          image: item.image,
          release_date: item.releaseDate,
          duration: item.duration,
          type: "movie",
          info_url: process.env.BASE_URL! + '/info?id=' + item.id
        }
      })

      const results = {
        sections: [
          {
            title: "Trending TV Series",
            media_items: [
              ...formattedTvTrending
            ]
          },
          {
            title: "Trending Movies",
            media_items: [
              ...formattedMoviesTrending
            ]
          }
        ]
      }

      rp.status(200).send(results);
    });

    fastify.get('/info', async (request: FastifyRequest, reply: FastifyReply) => {
      const id = (request.query as { id: string }).id;

      if (typeof id === 'undefined')
        return reply.status(400).send({
          message: 'id is required',
        });

      try {
        const res = await cache.fetch(
          redis as Redis,
          `flixhq:info:${id}`,
          async () => await flixhq.fetchMediaInfo(id),
          60 * 60 * 3
        )

        let formattedResponse = {}

        if(res.type == TvType.MOVIE) {
          formattedResponse = {
            id: res.id,
            title: res.title,
            cover: res.cover,
            image: res.image,
            description: res.description,
            type: "movie",
            release_date: res.releaseDate,
            duration: res.duration,
            rating: res.rating,
            episodes: {
              watch_url: process.env.BASE_URL! + '/watch?episodeId=' + res.episodes![0].id + '&mediaId=' + res.id
            }
          }
        } else {
          formattedResponse = {
            id: res.id,
            title: res.title,
            cover: res.cover,
            image: res.image,
            description: res.description,
            type: "series",
            release_date: res.releaseDate,
            duration: res.duration,
            rating: res.rating,
            episodes: res.episodes!.map((item) => {
              return {
                title: item.title,
                episode: item.number,
                season: item.season,
                watch_url: process.env.BASE_URL! + '/watch?episodeId=' + item.id + '&mediaId=' + res.id
              }
            })
          }
        }

        reply.status(200).send(formattedResponse);
      } catch (err) {
        reply.status(500).send({
          message:
            'Something went wrong. Please try again later. or contact the developers.',
        });
      }
    });

    fastify.get('/watch', async (request: FastifyRequest, reply: FastifyReply) => {
      const episodeId = (request.query as { episodeId: string }).episodeId;
      const mediaId = (request.query as { mediaId: string }).mediaId;
      const server = (request.query as { server: StreamingServers }).server;

      if (typeof episodeId === 'undefined')
        return reply.status(400).send({ message: 'episodeId is required' });
      if (typeof mediaId === 'undefined')
        return reply.status(400).send({ message: 'mediaId is required' });

      if (server && !Object.values(StreamingServers).includes(server))
        return reply.status(400).send({ message: 'Invalid server query' });

      try {
        const res = await cache.fetch(
          redis as Redis,
          `flixhq:watch:${episodeId}:${mediaId}:${server}`,
          async () => await flixhq.fetchEpisodeSources(episodeId, mediaId, server),
          60 * 30
        )

        const formattedResponse = {
          url: res.sources.slice(-1)[0].url,
          subtitles: res.subtitles
        }

        reply.status(200).send(formattedResponse);
      } catch (err) {
        reply
          .status(500)
          .send({ message: 'Something went wrong. Please try again later.' });
      }
    });

    fastify.get('/search/:query', async (request: FastifyRequest, reply: FastifyReply) => {
      const query = decodeURIComponent((request.params as { query: string }).query);

      const page = (request.query as { page: number }).page;

      let res = await cache.fetch(
        redis as Redis,
        `flixhq:${query}:${page}`,
        async () => await flixhq.search(query, page ? page : 1),
        60 * 60 * 6
      )

      const formattedResults = res.results.map((item) => {
        if(item.type == TvType.MOVIE) {
          return {
            id: item.id,
            title: item.title,
            image: item.image,
            release_date: item.releaseDate,
            duration: item.duration,
            type: "movie",
            info_url: process.env.BASE_URL! + '/info?id=' + item.id
          }
        } else {
          return {
            id: item.id,
            title: item.title,
            image: item.image,
            seasons: item.seasons ?? item.seasons,
            type: "series",
            info_url: process.env.BASE_URL! + '/info?id=' + item.id
          }
        }
      })

      const nextPageUrl = res.hasNextPage
        ? process.env.BASE_URL! + '/search/' + encodeURIComponent(query) + '?page=' + (parseInt(res.currentPage!.toString()) + 1).toString() // dont ask
        : null

      const prevPageUrl = res.currentPage! > 1
        ? process.env.BASE_URL! + '/search/' + encodeURIComponent(query) + '?page=' + (parseInt(res.currentPage!.toString()) - 1).toString() // dont ask
        : null

      reply.status(200).send({
        next_page_url: nextPageUrl,
        prev_page_url: prevPageUrl,
        media_items: formattedResults
      });
    });

    // fastify.get('/main', async (_, rp) => {
    //   const tvTrending = await cache.fetch(
    //     redis as Redis,
    //     `flixhq:trending:tv`,
    //     async () => await flixhq.fetchTrendingTvShows(),
    //     60 * 60 * 3
    //   )

    //   const formattedTvTrending = tvTrending.map((item) => {
    //     return {
    //       id: item.id,
    //       title: item.title,
    //       image: item.image,
    //       latest_season: (item.season! as string).replace(/SS |S /g, ""),
    //       latest_episode: (item.latestEpisode! as string).replace(/EP |EPS /g, ""),
    //       type: "series",
    //       info_url: process.env.BASE_URL! + '/info?id=' + item.id
    //     }
    //   })

    //   const moviesTrending = await cache.fetch(
    //     redis as Redis,
    //     `flixhq:trending:movies`,
    //     async () => await flixhq.fetchTrendingMovies(),
    //     60 * 60 * 3
    //   )

    //   const formattedMoviesTrending = moviesTrending.map((item) => {
    //     return {
    //       id: item.id,
    //       title: item.title,
    //       image: item.image,
    //       release_date: item.releaseDate,
    //       duration: item.duration,
    //       type: "movie",
    //       info_url: process.env.BASE_URL! + '/info?id=' + item.id
    //     }
    //   })

    //   const results = {
    //     sections: [
    //       {
    //         title: "Trending TV Series",
    //         media_items: [
    //           ...formattedTvTrending
    //         ]
    //       },
    //       {
    //         title: "Trending Movies",
    //         media_items: [
    //           ...formattedMoviesTrending
    //         ]
    //       }
    //     ]
    //   }

    //   rp.status(200).send(results);
    // });

    fastify.get('*', (request, reply) => {
      reply.status(404).send({
        message: '',
        error: 'page not found',
      });
    });

    fastify.listen({ port: PORT, host: '0.0.0.0' }, (e, address) => {
      if (e) throw e;
      console.log(`server listening on ${address}`);
    });
  } catch (err: any) {
    fastify.log.error(err);
    process.exit(1);
  }
})();
