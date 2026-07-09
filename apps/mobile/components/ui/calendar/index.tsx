'use client'

import React from 'react'
import { createCalendar, type ICalendarProps } from '@gluestack-ui/core/calendar/creator'
import { Pressable, Text, View } from 'react-native'

import { Menu, MenuItem, MenuItemLabel } from '../menu'
import {
  calendarBodyStyle,
  calendarDayIndicatorStyle,
  calendarDayStyle,
  calendarDayTextStyle,
  calendarFooterStyle,
  calendarGridStyle,
  calendarHeaderButtonStyle,
  calendarHeaderSelectStyle,
  calendarHeaderStyle,
  calendarHeaderTitleStyle,
  calendarStyle,
  calendarWeekDayStyle,
  calendarWeekDaysHeaderStyle,
  calendarWeekDayTextStyle,
  calendarWeekNumberStyle,
  calendarWeekNumberTextStyle,
  calendarWeekStyle,
} from './styles'

// Styled Root Component
const CalendarRoot = React.forwardRef<
  React.ElementRef<typeof View>,
  ICalendarProps & React.ComponentProps<typeof View> & { className?: string }
>(({ className, ...props }, ref) => {
  return <View className={calendarStyle({ class: className })} ref={ref} {...props} />
})

// Styled Header
const CalendarHeaderRoot = React.forwardRef<
  React.ElementRef<typeof View>,
  React.ComponentProps<typeof View> & { className?: string }
>(({ className, ...props }, ref) => {
  return <View className={calendarHeaderStyle({ class: className })} ref={ref} {...props} />
})

const CalendarHeaderPrevButtonRoot = React.forwardRef<
  React.ElementRef<typeof Pressable>,
  React.ComponentProps<typeof Pressable> & {
    className?: string
    disabled?: boolean
  }
>(({ className, disabled, ...props }, ref) => {
  return (
    <Pressable
      className={calendarHeaderButtonStyle({ class: className })}
      data-disabled={disabled}
      ref={ref}
      {...props}
    />
  )
})

const CalendarHeaderNextButtonRoot = React.forwardRef<
  React.ElementRef<typeof Pressable>,
  React.ComponentProps<typeof Pressable> & {
    className?: string
    disabled?: boolean
  }
>(({ className, disabled, ...props }, ref) => {
  return (
    <Pressable
      className={calendarHeaderButtonStyle({ class: className })}
      data-disabled={disabled}
      ref={ref}
      {...props}
    />
  )
})

const CalendarHeaderTitleRoot = React.forwardRef<
  React.ElementRef<typeof Text>,
  React.ComponentProps<typeof Text> & { className?: string }
>(({ className, ...props }, ref) => {
  return <Text className={calendarHeaderTitleStyle({ class: className })} ref={ref} {...props} />
})

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

type SelectRootProps = React.ComponentProps<typeof View> & {
  className?: string
  items?: Array<{ label: string; value: number }>
  selectedValue?: number
  onValueChange?: (value: number) => void
}

const CalendarHeaderMonthSelectRoot = React.forwardRef<React.ElementRef<typeof View>, SelectRootProps>(
  ({ className, items = [], selectedValue, onValueChange, ...props }, ref) => {
    const label = selectedValue !== undefined ? MONTH_NAMES[selectedValue] : 'Month'
    return (
      <View className={calendarHeaderSelectStyle({ class: className })} ref={ref} {...props}>
        <Menu
          offset={4}
          placement="bottom"
          trigger={({ ...triggerProps }) => (
            <Pressable {...triggerProps} className="flex-row items-center rounded-md px-2 py-1">
              <Text className="font-medium text-foreground text-sm">{label}</Text>
            </Pressable>
          )}
        >
          {items.map((item) => (
            <MenuItem key={item.value} onPress={() => onValueChange?.(item.value)} textValue={item.label}>
              <MenuItemLabel className={item.value === selectedValue ? 'font-semibold text-primary' : ''}>
                {item.label}
              </MenuItemLabel>
            </MenuItem>
          ))}
        </Menu>
      </View>
    )
  }
)

const CalendarHeaderYearSelectRoot = React.forwardRef<React.ElementRef<typeof View>, SelectRootProps>(
  ({ className, items = [], selectedValue, onValueChange, ...props }, ref) => {
    const label = selectedValue !== undefined ? String(selectedValue) : 'Year'
    return (
      <View className={calendarHeaderSelectStyle({ class: className })} ref={ref} {...props}>
        <Menu
          offset={4}
          placement="bottom"
          trigger={({ ...triggerProps }) => (
            <Pressable {...triggerProps} className="flex-row items-center rounded-md px-2 py-1">
              <Text className="font-medium text-foreground text-sm">{label}</Text>
            </Pressable>
          )}
        >
          {items.map((item) => (
            <MenuItem key={item.value} onPress={() => onValueChange?.(item.value)} textValue={item.label}>
              <MenuItemLabel className={item.value === selectedValue ? 'font-semibold text-primary' : ''}>
                {item.label}
              </MenuItemLabel>
            </MenuItem>
          ))}
        </Menu>
      </View>
    )
  }
)

// Styled Week Days Header
const CalendarWeekDaysHeaderRoot = React.forwardRef<
  React.ElementRef<typeof View>,
  React.ComponentProps<typeof View> & { className?: string }
>(({ className, ...props }, ref) => {
  return <View className={calendarWeekDaysHeaderStyle({ class: className })} ref={ref} {...props} />
})

const CalendarWeekDayRoot = React.forwardRef<
  React.ElementRef<typeof View>,
  React.ComponentProps<typeof View> & { className?: string }
>(({ className, children, ...props }, ref) => {
  return (
    <View className={calendarWeekDayStyle({ class: className })} ref={ref} {...props}>
      {typeof children === 'string' ? (
        <Text className={calendarWeekDayTextStyle({ class: '' })}>{children}</Text>
      ) : (
        children
      )}
    </View>
  )
})

// Styled Body & Grid
const CalendarBodyRoot = React.forwardRef<
  React.ElementRef<typeof View>,
  React.ComponentProps<typeof View> & { className?: string }
>(({ className, ...props }, ref) => {
  return <View className={calendarBodyStyle({ class: className })} ref={ref} {...props} />
})

const CalendarGridRoot = React.forwardRef<
  React.ElementRef<typeof View>,
  React.ComponentProps<typeof View> & { className?: string }
>(({ className, ...props }, ref) => {
  return <View className={calendarGridStyle({ class: className })} ref={ref} {...props} />
})

const CalendarWeekRoot = React.forwardRef<
  React.ElementRef<typeof View>,
  React.ComponentProps<typeof View> & { className?: string }
>(({ className, ...props }, ref) => {
  return <View className={calendarWeekStyle({ class: className })} ref={ref} {...props} />
})

// Styled Day
const CalendarDayRoot = React.forwardRef<
  React.ElementRef<typeof Pressable>,
  React.ComponentProps<typeof Pressable> & {
    className?: string
    'data-state'?: string
  }
>(({ className, 'data-state': dataState, ...props }, ref) => {
  return (
    <Pressable
      className={calendarDayStyle({
        state: dataState as any,
        class: className,
      })}
      ref={ref}
      {...props}
    />
  )
})

const CalendarDayTextRoot = React.forwardRef<
  React.ElementRef<typeof Text>,
  React.ComponentProps<typeof Text> & { className?: string; state?: any }
>(({ className, state, ...props }, ref) => {
  return (
    <Text
      className={calendarDayTextStyle({
        state:
          state?.isSelected && state?.isRangeStart
            ? 'range-start'
            : state?.isSelected && state?.isRangeEnd
              ? 'range-end'
              : state?.isInRange
                ? 'range-middle'
                : state?.isSelected
                  ? 'selected'
                  : state?.isToday
                    ? 'today'
                    : state?.isDisabled
                      ? 'disabled'
                      : state?.isOutsideMonth
                        ? 'outside-month'
                        : 'default',
        class: className,
      })}
      ref={ref}
      {...props}
    />
  )
})

const CalendarDayIndicatorRoot = React.forwardRef<
  React.ElementRef<typeof View>,
  React.ComponentProps<typeof View> & {
    className?: string
    'data-type'?: string
  }
>(({ className, 'data-type': dataType, ...props }, ref) => {
  return (
    <View
      className={calendarDayIndicatorStyle({
        type: dataType as any,
        class: className,
      })}
      ref={ref}
      {...props}
    />
  )
})

// Styled Week Number
const CalendarWeekNumberRoot = React.forwardRef<
  React.ElementRef<typeof View>,
  React.ComponentProps<typeof View> & { className?: string }
>(({ className, children, ...props }, ref) => {
  return (
    <View className={calendarWeekNumberStyle({ class: className })} ref={ref} {...props}>
      {typeof children === 'string' || typeof children === 'number' ? (
        <Text className={calendarWeekNumberTextStyle({ class: '' })}>{children}</Text>
      ) : (
        children
      )}
    </View>
  )
})

// Styled Footer
const CalendarFooterRoot = React.forwardRef<
  React.ElementRef<typeof View>,
  React.ComponentProps<typeof View> & { className?: string }
>(({ className, ...props }, ref) => {
  return <View className={calendarFooterStyle({ class: className })} ref={ref} {...props} />
})

// Create Calendar using the factory
const UICalendar = createCalendar({
  Root: CalendarRoot,
  Header: CalendarHeaderRoot,
  HeaderPrevButton: CalendarHeaderPrevButtonRoot,
  HeaderNextButton: CalendarHeaderNextButtonRoot,
  HeaderTitle: CalendarHeaderTitleRoot,
  HeaderMonthSelect: CalendarHeaderMonthSelectRoot,
  HeaderYearSelect: CalendarHeaderYearSelectRoot,
  WeekDaysHeader: CalendarWeekDaysHeaderRoot,
  WeekDay: CalendarWeekDayRoot,
  Body: CalendarBodyRoot,
  Grid: CalendarGridRoot,
  Week: CalendarWeekRoot,
  Day: CalendarDayRoot,
  DayText: CalendarDayTextRoot,
  DayIndicator: CalendarDayIndicatorRoot,
  WeekNumber: CalendarWeekNumberRoot,
  Footer: CalendarFooterRoot,
})

// Mode-specific discriminated union props so onValueChange is correctly
// narrowed per mode (prevents TypeScript errors when passing setState).
type OmittedCalendarKeys = 'mode' | 'value' | 'defaultValue' | 'onValueChange'

type SingleModeProps = {
  mode?: 'single'
  value?: Date
  defaultValue?: Date
  onValueChange?: (value: Date) => void
}

type MultipleModeProps = {
  mode: 'multiple'
  value?: Date[]
  defaultValue?: Date[]
  onValueChange?: (value: Date[]) => void
}

type RangeModeProps = {
  mode: 'range'
  value?: { from: Date; to?: Date }
  defaultValue?: { from: Date; to?: Date }
  onValueChange?: (value: { from: Date; to?: Date }) => void
}

type CalendarProps = (SingleModeProps | MultipleModeProps | RangeModeProps) &
  Omit<ICalendarProps, OmittedCalendarKeys> &
  Omit<React.ComponentProps<typeof View>, OmittedCalendarKeys> & {
    className?: string
  }

const CalendarComponent = React.forwardRef<React.ElementRef<typeof View>, CalendarProps>((props, ref) => {
  return <UICalendar ref={ref} {...(props as any)} />
})
CalendarComponent.displayName = 'Calendar'

// Export components
export const Calendar = CalendarComponent
export const CalendarHeader = UICalendar.Header
export const CalendarHeaderPrevButton = UICalendar.HeaderPrevButton
export const CalendarHeaderNextButton = UICalendar.HeaderNextButton
export const CalendarHeaderTitle = UICalendar.HeaderTitle
export const CalendarHeaderMonthSelect = UICalendar.HeaderMonthSelect
export const CalendarHeaderYearSelect = UICalendar.HeaderYearSelect
export const CalendarWeekDaysHeader = UICalendar.WeekDaysHeader
export const CalendarWeekDay = UICalendar.WeekDay
export const CalendarBody = UICalendar.Body
export const CalendarGrid = UICalendar.Grid
export const CalendarWeek = UICalendar.Week
export const CalendarDay = UICalendar.Day
export const CalendarDayText = UICalendar.DayText
export const CalendarDayIndicator = UICalendar.DayIndicator
export const CalendarWeekNumber = UICalendar.WeekNumber
export const CalendarFooter = UICalendar.Footer

// Re-export types
export type {
  CalendarMarker,
  CalendarMarkers,
  CalendarMode,
  DayState,
  ICalendarProps,
} from '@gluestack-ui/core/calendar/creator'

export type { CalendarProps }
