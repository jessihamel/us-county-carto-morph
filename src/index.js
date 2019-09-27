
import { csvParse } from 'd3-dsv'
import { scaleSqrt, scaleLinear } from 'd3-scale'
import { max } from 'd3-array'
import { geoAlbersUsa, geoCentroid, geoArea, geoPath } from 'd3-geo'
import TWEEN from '@tweenjs/tween.js'
import { interpolate, combine } from 'flubber'

import geoData from './data/us_county.json'
import countyData from './data/PEP_2018_PEPANNRES_with_ann.csv'

const defaultWidth = 960
const defaultHeight = 500
const mapAspectRatio = defaultHeight / defaultWidth
const maxCircleRadius = 30
const mapAnimationTime = 3000

const countyStrokeColor = '#003E5F'
const countyFillColor = '#003E5FB3'

const smallestTweenArea = 25

class CountyMorph {

  constructor() {
    // create canvas element
    this.mapWrapper = document.createElement('canvas')
    document.body.appendChild(this.mapWrapper)

    // init various properties we'll need
    this.populationScale = scaleSqrt()
    this.tweenProperties = {t: 0}
    this.animationTween = new TWEEN.Tween(this.tweenProperties)
    this.projection = geoAlbersUsa()

    // bind animation method so we can call it within requestAnimationFrame
    this.animateMap = this.animateMap.bind(this)

    // set up initial dimensions and resize handlers
    this.updateProjectionFromWidth()
    this.initData()
    this.initTween()

    window.addEventListener('resize', () => {
      window.cancelAnimationFrame(this.animationFrame)
      this.updateProjectionFromWidth()
      this.initData()
    })
  }

  // dynamic sizing of map
  updateProjectionFromWidth() {

    // set up width/height variables
    this.width = window.innerWidth
    this.height = this.width * mapAspectRatio

    // resize canvas
    this.mapWrapper.width = this.width
    this.mapWrapper.height = this.height

    // set up projection given width/height
    this.projection
      .scale(this.width)
      .translate([
        this.width / 2,
        this.height / 2
      ])

    // update pathFn method with latest projection
    this.pathFn = geoPath(this.projection, this.getMapContext())
  }

  // helper fn to return map context
  getMapContext() {
    return this.mapWrapper.getContext('2d')
  }

  // large fn that does the data heavy-lifting
  initData() {
    // organize county data by geoid for quick lookup
    const countyPopulationData = countyData.reduce((a, b, i) => {
      if (i === 0) { return a } // ignore headers
      a[b[1]] = +(b[3])
      return a
    }, {})

    // calculate max population
    this.maxPopulation = max(Object.values(countyPopulationData))

    // set up some scales for later tweening
    this.populationScale
      .domain([0, this.maxPopulation])
      .range([0, maxCircleRadius])

    // sorry puerto rico, etc.
    const territories = ['60', '66', '69', '72', '78']
    const geoDataMinusTerritories = geoData.features.filter(feature => {
      const state = feature.properties.STATEFP
      return territories.indexOf(state) === -1
    })

    // organize geo data by state and merge with countyPopulationData
    this.countyGeoData = geoDataMinusTerritories.map(c => {
      const county = {...c}
      const state = county.properties.STATEFP
      const countyId = county.properties.GEOID
      const populationData = +(countyPopulationData[countyId])
      if (!populationData) {
        console.warn('No population data found for ' + countyId)
      }

      // add population data to the county properties
      county.population = populationData

      // when a county is a multipolygon, get the largest area,
      //  this will be useful for calculating county centroids and for
      //  tweening the shapes
      if (county.geometry.type === 'MultiPolygon') {
        county.largestArea = 0
        county.largestAreaIndex = 0
        // we will fade out tiny geometries rather than try to tween them
        county.tinyGeometryIndicies = []
        county.geometry.coordinates.forEach((polygon, i) => {
          const area = this.pathFn.area({
            type: 'Feature',
            geometry: {
              type: 'Polygon',
              coordinates: polygon
            }
          })
          if (area > county.largestArea) {
            county.largestArea = area
            county.largestAreaIndex = i
          }
          if (area < smallestTweenArea) {
            county.tinyGeometryIndicies.push(i)
          }
        })
        county.centroid = this.projection(geoCentroid({
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: county.geometry.coordinates[county.largestAreaIndex]
          }
        }))
      }
      else { // much easier for 'Polygon' geometries
        county.largestAreaIndex = 0
        county.centroid = this.projection(geoCentroid(county))
      }

      // now let's pre-calculate the map projection, this allows us to later
      //  use the same function for drawing the states as the cartogram
      county.projectedGeometry = []
      if (county.geometry.type === 'Polygon') {
        county.projectedGeometry = county.geometry.coordinates.map(coordArray => {
          return coordArray.map(coord => this.projection(coord))
        })
      } else if (county.geometry.type === 'MultiPolygon') {
        county.projectedGeometry = county.geometry.coordinates.map(feature => {
          return feature.map(coordArray => {
            return coordArray.map(coord => {
              if (!this.projection(coord)) {
                console.warn('error projecting ', coord)
              }
              return this.projection(coord)
            })
          })
        })
          .reduce((a, b) => a.concat(b), [])
          .filter((coordArray) => {
            // Some Hawaii islets seem like they're outside the projection,
            //  filter them out here
            return coordArray.indexOf(null) === -1
          })
      }

      // set up interpolation functions that will be called as the time
      //  changes
      const r = this.populationScale(county.population)
      county.circleCoords = this.generateCircleCoords(r, county.centroid)
      if (county.projectedGeometry.length === 1) {
        county.interpolator = interpolate(
          county.projectedGeometry[0],
          county.circleCoords,
          {string: false}
        )
      } else {
        // set up some properties for interpolation
        try {
          const geometriesMinusTinyOnes = county.projectedGeometry
            .filter((_, i) => {
              return county.tinyGeometryIndicies.indexOf(i) === -1
            })
          county.interpolator = combine(
            geometriesMinusTinyOnes,
            county.circleCoords,
            {string: false}
          )
        }
        catch {
          county.interpolator = interpolate(
            county.projectedGeometry[county.largestAreaIndex],
            county.circleCoords,
            {string: false}
          )
        }
      }
      return county
    })

    this.countyGeoData.sort((a, b) => b.population - a.population)

    this.animateMap()
  }

  // drawing helper for circle r at point
  generateCircleCoords(r, centroid) {
    const d = r * Math.PI * 2
    const circleCoords = []
    const nSegments = Math.max(Math.ceil(d / 3), 4)
    for (let i = 0; i <= nSegments; i++) {
      const angle = ( i / nSegments ) * 2 * Math.PI
      const x = r * Math.cos(angle)
      const y = r * Math.sin(angle)
      circleCoords.push([x + centroid[0], y + centroid[1]])
    }
    return circleCoords
  }

  initTween() {
    this.animationTween
      .interpolation( TWEEN.Interpolation.Bezier )
      .delay(mapAnimationTime / 2)
      .to({t: 1}, mapAnimationTime)
      .repeat( Infinity )
      .yoyo(true)
    this.animationTween.start()
  }

  // main animation loop
  animateMap() {
    TWEEN.update()
    const ctx = this.getMapContext()
    ctx.clearRect(0, 0, this.width, this.height)
    this.drawMap()
    this.animationFrame = window.requestAnimationFrame(this.animateMap)
  }

  // map map drawing logic
  drawMap() {
    const tweenTime = this.tweenProperties.t
    const drawRawMap = tweenTime === 0
    this.countyGeoData.forEach((feature, featureIndex) => {
      if (drawRawMap) {
        this.drawMapFeature(feature, true)
      } else if (tweenTime === 1) {
        this.drawMapFeature([feature.circleCoords])
      } else {
        if (feature.tinyGeometryIndicies) {
          this.drawMapFeature(
            feature.tinyGeometryIndicies.map(
              index => feature.projectedGeometry[index]
            ),
            false,
            Math.max(1 - (tweenTime * 2), 0) // fades tiny features out
          )
        }
        if (typeof feature.interpolator !== 'function') {
          feature.interpolator.forEach(interpolatorFn => {
            this.drawMapFeature(
              [interpolatorFn(tweenTime)],
            )
          })
        } else {
          this.drawMapFeature(
            [feature.interpolator(tweenTime)],
          )
        }
      }
    })
  }

  drawMapFeature(featureCoordinates, rawMap = false, alpha = false) {
    const ctx = this.getMapContext()
    if (alpha !== false) {
      ctx.save()
      ctx.globalAlpha = alpha
    }
    ctx.strokeStyle = countyStrokeColor
    ctx.lineWidth = 0.8
    ctx.fillStyle = countyFillColor
    if (rawMap) {
      ctx.beginPath()
      this.pathFn(featureCoordinates)
      ctx.closePath()
      ctx.stroke()
      ctx.fill()
    } else {
      featureCoordinates.forEach(coordArray => {
        ctx.beginPath()
        coordArray.forEach((coord, i) => {
          if (!coord) {
            return
          }
          if (i === 0) {
            ctx.moveTo(coord[0], coord[1])
          } else {
            ctx.lineTo(coord[0], coord[1])
          }
        })
        ctx.closePath()
        ctx.stroke()
        ctx.fill()
      })
    }
    if (alpha !== false) {
      ctx.restore()
    }
  }

}

new CountyMorph()
