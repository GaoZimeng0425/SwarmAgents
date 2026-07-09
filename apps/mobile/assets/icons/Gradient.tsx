import React from 'react'
import { Defs, Ellipse, G, RadialGradient, Stop, Svg } from 'react-native-svg'

const SvgComponent = () => {
  return (
    <Svg fill="none" height="1078" viewBox="0 0 965 1078" width="965">
      <G opacity="1">
        <G>
          <Ellipse cx="222.599" cy="277.706" fill="url(#paint0_radial_2913_5676)" rx="641.842" ry="699.982" />
        </G>
        <G>
          <Ellipse cx="-82.2838" cy="30.7211" fill="url(#paint1_radial_2913_5676)" rx="463.716" ry="505.721" />
        </G>
      </G>
      <Defs>
        <RadialGradient
          cx="0"
          cy="0"
          gradientTransform="translate(222.599 277.706) rotate(90) scale(780.255 715.448)"
          gradientUnits="userSpaceOnUse"
          id="paint0_radial_2913_5676"
          r="1"
        >
          <Stop offset="0%" stopColor="#FFFFFF" />
          <Stop offset="100%" stopColor="#121212" stopOpacity="0" />
        </RadialGradient>
        <RadialGradient
          cx="0"
          cy="0"
          gradientTransform="translate(-82.2838 30.7211) rotate(90) scale(563.717 516.895)"
          gradientUnits="userSpaceOnUse"
          id="paint1_radial_2913_5676"
          r="1"
        >
          <Stop offset="0%" stopColor="#121212" />
          <Stop offset="100%" stopColor="#121212" stopOpacity="0" />
        </RadialGradient>
      </Defs>
    </Svg>
  )
}

export default SvgComponent
